// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import {IEndex} from "./IEndex.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "hardhat/console.sol";

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

contract Endex is IEndex {
    using SafeERC20 for IERC20;

    // -------- Constants --------
    uint256 public constant MAX_LEVERAGE_X = 5;     // 5x
    uint256 public constant CLOSE_FEE_BPS    = 10;  // 0.1% close fee
    uint256 public constant BPS_DIVISOR      = 10_000;

    // Funding / math scales
    uint256  public constant ONE_X18 = 1e18;
    euint256 public immutable ENC_ONE_X18;
    uint256  public constant MAINT_MARGIN_BPS = 100; // 1%
    uint256  public constant MIN_NOTIONAL_USDC = 10e6; // 10 USDC (6d) — frontends should enforce

    // Funding rate cap and linear coefficient (tunable)
    euint256 public immutable FUNDING_K_X12; // scales encrypted skew to rate numerator
    uint256  public constant MAX_ABS_FUNDING_RATE_PER_SEC_X18 = 1e9; // ~0.0864%/day

    // ===== Price Impact Params (ETH-only tuning) =====
    // Quadratic coefficient (dimensionless, X18). Initial guess; tune on testnet.
    uint256 public constant IMPACT_GAMMA_X18     = 3e15;        // 0.003
    uint256 public constant IMPACT_TVL_FACTOR_BPS = 5000;       // 50% of pool balance
    uint256 public constant IMPACT_MIN_LIQ_USD    = 500_000e6;  // 500k USDC floor (6d)
    uint256 public constant IMPACT_UTIL_BETA_X18  = 1e18;       // strengthen impact under high |rate|
    uint256 private constant IMPACT_SCALER        = 1e14;       // see units derivation

    // Tokens and oracle
    IERC20 public immutable usdc;          // 6 decimals
    IAggregatorV3 public immutable ethUsdFeed; // 8 decimals

    // LP accounting
    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;
    uint256 public usdcBalance; // pool USDC (6d)

    // Positions
    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) internal positions;

    // Keeper heartbeat state (last observed round)
    uint80 public lastRoundId;

    // -------- Funding state --------
    int256  public fundingRatePerSecX18; // signed, per second, X18
    int256  public cumFundingLongX18;    // signed cumulative index X18
    int256  public cumFundingShortX18;   // signed cumulative index X18
    uint256 public lastFundingUpdate;

    // -------- Encrypted OI aggregates (never decrypted) --------
    euint256 private encLongOI;  // sum of encrypted long notionals (1e6)
    euint256 private encShortOI; // sum of encrypted short notionals (1e6)

    // Funding request state
    bool    public fundingPending;
    uint64  public fundingEpoch;
    uint256 public fundingRequestedAt;
    euint256 private pendingRateNumeratorEnc; // |skew| * K (encrypted)
    euint256 private pendingSkewFlagEnc;      // 0/1 encrypted (longOI >= shortOI)

    // ===============================
    // Constructor
    // ===============================

    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed) {
        usdc = _usdc;
        ethUsdFeed = _ethUsdFeed;

        lastFundingUpdate = block.timestamp;

        encLongOI = FHE.asEuint256(0);
        encShortOI = FHE.asEuint256(0);
        FUNDING_K_X12 = FHE.asEuint256(1e12);
        ENC_ONE_X18   = FHE.asEuint256(ONE_X18);
        pendingRateNumeratorEnc = FHE.asEuint256(0);

        // Permissions for ciphertexts used by this contract
        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        FHE.allowThis(pendingRateNumeratorEnc);
        FHE.allowThis(FUNDING_K_X12);
        FHE.allowThis(ENC_ONE_X18);
    }

    // ===============================
    // LP FUNCTIONS
    // ===============================

    event LpDeposit(address indexed lp, uint256 amount, uint256 sharesMinted);
    event LpWithdraw(address indexed lp, uint256 shares, uint256 amountReturned);

    function lpDeposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 shares = totalLpShares == 0 ? amount : (amount * totalLpShares) / usdcBalance;
        lpShares[msg.sender] += shares;
        totalLpShares += shares;
        usdcBalance += amount;
        emit LpDeposit(msg.sender, amount, shares);
    }

    function lpWithdraw(uint256 shares) external {
        require(shares > 0 && shares <= lpShares[msg.sender], "bad shares");
        uint256 amount = (shares * usdcBalance) / totalLpShares;
        lpShares[msg.sender] -= shares;
        totalLpShares -= shares;
        usdcBalance -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit LpWithdraw(msg.sender, shares, amount);
    }

    // ===============================
    // FUNDING: accrual + rate updates
    // ===============================

    /// @dev Accrue cumulative funding using current fundingRatePerSecX18.
    function pokeFunding() public {
        uint256 nowTs = block.timestamp;
        if (nowTs == lastFundingUpdate) return;

        int256 dt = int256(nowTs - lastFundingUpdate);
        // long side accrues +rate; short side accrues -rate
        cumFundingLongX18  += fundingRatePerSecX18 * dt;
        cumFundingShortX18 -= fundingRatePerSecX18 * dt;
        lastFundingUpdate = nowTs;

        emit FundingAccrued(fundingRatePerSecX18, cumFundingLongX18, cumFundingShortX18, nowTs);
    }

    /// @dev Request to compute funding rate from encrypted skew without underflow:
    /// encDelta = max(encLongOI, encShortOI) - min(encLongOI, encShortOI)
    function requestFundingRateFromSkew() external {
        require(!fundingPending, "funding: pending");
        pokeFunding(); // accrue with old rate up to now

        ebool  condGE  = FHE.gte(encLongOI, encShortOI); // true if long >= short
        euint256 encA  = FHE.select(condGE, encLongOI, encShortOI);
        euint256 encB  = FHE.select(condGE, encShortOI, encLongOI);
        euint256 encDelta = FHE.sub(encA, encB); // |skew|

        // numerator = |skew| * K (encrypted)
        pendingRateNumeratorEnc = FHE.mul(encDelta, FUNDING_K_X12);

        // encrypted 0/1 sign flag (long >= short ? 1 : 0)
        pendingSkewFlagEnc = FHE.select(condGE, FHE.asEuint256(1), FHE.asEuint256(0));

        // request async decrypts
        FHE.decrypt(pendingRateNumeratorEnc);
        FHE.decrypt(pendingSkewFlagEnc);

        // mark pending
        fundingPending = true;
        fundingRequestedAt = block.timestamp;
        fundingEpoch += 1;

        emit FundingRateRequested(fundingEpoch);
    }

    /// @dev Finalize funding rate: read decrypted magnitude and sign, scale & clamp.
    function commitFundingRate(uint64 epoch) external {
        require(fundingPending && epoch == fundingEpoch, "funding: no pending/epoch");

        // read both decrypt results (must be ready)
        (uint256 num,  bool r1) = FHE.getDecryptResultSafe(pendingRateNumeratorEnc); // |skew|*K
        (uint256 flag, bool r2) = FHE.getDecryptResultSafe(pendingSkewFlagEnc);      // 1 if long>=short
        require(r1 && r2, "funding: not ready");

        // signed numerator from flag
        int256 signedNum = (flag == 1) ? int256(num) : -int256(num);

        // scale to per-second X18 (K chosen so /1e6 returns X18)
        int256 rateX18 = signedNum / int256(1e6);

        // clamp
        int256 max = int256(MAX_ABS_FUNDING_RATE_PER_SEC_X18);
        if (rateX18 > max) rateX18 = max;
        else if (rateX18 < -max) rateX18 = -max;

        // accrue with old rate, then set new
        pokeFunding();
        fundingRatePerSecX18 = rateX18;

        // clear pending
        fundingPending = false;

        // zero the pending ciphers (optional hygiene)
        pendingRateNumeratorEnc = FHE.asEuint256(0);
        pendingSkewFlagEnc      = FHE.asEuint256(0);
        FHE.allowThis(pendingRateNumeratorEnc);
        FHE.allowThis(pendingSkewFlagEnc);

        emit FundingRateCommitted(rateX18, epoch);
    }

    // ===============================
    // TRADING API
    // ===============================

    /**
     * @notice Opens a position.
     * @dev The requested encrypted `size_` is PRIVATELY CLAMPED into
     *      [MIN_NOTIONAL_USDC, collateral * MAX_LEVERAGE_X]. If `size_` is below the minimum
     *      (including zero), the effective size is set to MIN_NOTIONAL_USDC. Frontends should
     *      enforce min-size to avoid surprises for users interacting directly with the contract.
     */
    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice
    ) external override {
        // Accrue funding before opening
        pokeFunding();

        // Price & collateral checks
        (, int256 price,,,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");
        require(collateral > 0, "collateral=0");

        // Clamp encrypted requested size to [MIN_NOTIONAL_USDC, collateral * MAX_LEVERAGE_X]
        euint256 size = _clampEncryptedSize(size_, collateral);

        // Pull collateral
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        usdcBalance += collateral;

        uint256 id = nextPositionId++;

        // --- Entry price impact buckets (encrypted) BEFORE updating OI ---
        (euint256 impGainX18, euint256 impLossX18) =
            _encImpactEntryBucketsAtOpenX18(isLong, size, uint256(price));

        positions[id] = Position({
            owner: msg.sender,
            positionId: id,
            isLong: isLong,
            size: size,
            collateral: collateral,
            entryPrice: uint256(price),
            stopLossPrice: stopLossPrice,
            takeProfitPrice: takeProfitPrice,
            settlementPrice: 0,
            status: Status.Open,
            cause: CloseCause.UserClose, // default; may be overwritten during close/liquidation/TP/SL
            entryFundingX18: (isLong ? cumFundingLongX18 : cumFundingShortX18),
            pendingLiqFlagEnc: FHE.asEuint256(0),
            pendingLiqCheckPrice: 0,
            liqCheckPending: false,
            encImpactEntryGainX18: impGainX18,
            encImpactEntryLossX18: impLossX18,
            pendingEquityX18: FHE.asEuint256(0)
        });

        Position storage p = positions[id];

        // Update encrypted OI aggregates (AFTER recording entry impact based on pre-trade OI)
        if (isLong) {
            encLongOI = FHE.add(encLongOI, size);
            emit EncryptedOIUpdated(true, true, id);
        } else {
            encShortOI = FHE.add(encShortOI, size);
            emit EncryptedOIUpdated(false, true, id);
        }

        // Permissions for ciphertexts
        FHE.allowThis(p.size);
        FHE.allowSender(p.size);
        FHE.allowThis(p.pendingLiqFlagEnc);
        FHE.allowSender(p.pendingLiqFlagEnc);
        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        FHE.allowThis(p.encImpactEntryGainX18);
        FHE.allowThis(p.encImpactEntryLossX18);
        FHE.allowThis(p.pendingEquityX18);

        emit PriceImpactApplied(id);
        emit PositionOpened(id, msg.sender, isLong, size, collateral, uint256(price));
    }

    function closePosition(uint256 positionId) external override {
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "not owner");
        require(p.status == Status.Open, "not open");
        p.cause = CloseCause.UserClose;
        _setupSettlement(p, _markPrice());
    }

    function settlePositions(uint256[] calldata positionIds) external override {
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            Position storage p = positions[id];
            if (p.status != Status.AwaitingSettlement) continue;
            _settle(id);
        }
    }

    function checkPositions(uint256[] calldata positionIds) external override {
        (uint80 rid,, , ,) = ethUsdFeed.latestRoundData();
        if (rid == lastRoundId) return;
        lastRoundId = rid;

        uint256 price = _markPrice();

        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            Position storage p = positions[id];
            if (p.status != Status.Open) continue;

            // Plaintext TP/SL (will move to encrypted later)
            bool hitTp = p.takeProfitPrice > 0 && (p.isLong ? price >= p.takeProfitPrice : price <= p.takeProfitPrice);
            bool hitSl = p.stopLossPrice   > 0 && (p.isLong ? price <= p.stopLossPrice   : price >= p.stopLossPrice);

            if (hitTp) {
                p.cause = CloseCause.TakeProfit;
                _setupSettlement(p, price);
                continue;
            }
            if (hitSl) {
                p.cause = CloseCause.StopLoss;
                _setupSettlement(p, price);
                continue;
            }
            // NOTE: liquidation handled via requestLiqChecks/finalizeLiqChecks
        }
    }

    function getPosition(uint256 positionId) external view override returns (Position memory) {
        return positions[positionId];
    }

    // ===============================
    // ENCRYPTED LIQUIDATION TRIGGER
    // ===============================

    /// @dev Step 1: compute encrypted (equity < maintenance) via non-negative operands; request decrypt of 0/1 flag.
    function requestLiqChecks(uint256[] calldata positionIds) external override {
        pokeFunding(); // keep funding fresh for equity calc
        uint256 price = _markPrice();

        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage p = positions[positionIds[i]];
            if (p.status != Status.Open) continue;

            // required = size * MAINT_MARGIN_BPS * 1e14 (BPS -> X18)
            euint256 encReqX18 = FHE.mul(p.size, FHE.asEuint256(MAINT_MARGIN_BPS * 1e14));

            (euint256 lhs, euint256 rhs) = _encEquityOperandsX18(p, price, encReqX18);

            // needLiq = (lhs < rhs)
            ebool needLiq = FHE.lt(lhs, rhs);

            // turn into 0/1 encrypted flag and request decrypt
            p.pendingLiqFlagEnc = FHE.select(needLiq, FHE.asEuint256(1), FHE.asEuint256(0));
            p.pendingLiqCheckPrice = price;
            p.liqCheckPending = true;
            FHE.decrypt(p.pendingLiqFlagEnc);

            FHE.allowThis(p.pendingLiqFlagEnc);
            FHE.allowThis(p.size);
        }
    }

    /// @dev Step 2: read decrypted flag; if 1, move position to AwaitingSettlement at stored price.
    function finalizeLiqChecks(uint256[] calldata positionIds) external override {
        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage p = positions[positionIds[i]];
            console.logBool(p.liqCheckPending);
            if (!p.liqCheckPending || p.status != Status.Open) continue;

            (uint256 flag, bool ready) = FHE.getDecryptResultSafe(p.pendingLiqFlagEnc);
            if (!ready) continue;

            p.liqCheckPending = false;

            console.log("flag:");
            console.log(flag);

            if (flag == 1) {
                p.cause = CloseCause.Liquidation;
                _setupSettlement(p, p.pendingLiqCheckPrice);
            }

            FHE.allowThis(p.pendingLiqFlagEnc);
        }
    }

    // ===============================
    // Internal helpers
    // ===============================

    function _markPrice() internal view returns (uint256) {
        (, int256 price,, ,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");
        return uint256(price);
    }

    /// @dev Clamp encrypted requested size into [MIN_NOTIONAL_USDC, collateral * MAX_LEVERAGE_X].
    function _clampEncryptedSize(InEuint256 calldata size_, uint256 collateral) internal returns (euint256) {
        euint256 _size  = FHE.asEuint256(size_);
        euint256 minEnc = FHE.asEuint256(MIN_NOTIONAL_USDC);
        euint256 maxEnc = FHE.asEuint256(collateral * MAX_LEVERAGE_X);

        // size1 = max(_size, MIN_NOTIONAL_USDC)
        euint256 size1  = FHE.select(FHE.lt(_size, minEnc), minEnc, _size);
        // size  = min(size1, collateral * MAX_LEVERAGE_X)
        euint256 size   = FHE.select(FHE.gt(size1, maxEnc), maxEnc, size1);

        return size;
    }

    /// @dev Price PnL buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _encPriceBucketsX18(
        Position storage p,
        uint256 price
    ) internal returns (euint256 gainX18, euint256 lossX18) {
        // ratioX18 = 1e18 * P / E  (plaintext for sign; encrypted magnitude below)
        uint256 ratioX18 = (price * ONE_X18) / p.entryPrice;
        uint256 deltaX18 = ratioX18 >= ONE_X18 ? (ratioX18 - ONE_X18) : (ONE_X18 - ratioX18);

        // Encrypted magnitude = size * |ratio - 1|
        euint256 encMagX18 = FHE.mul(p.size, FHE.asEuint256(deltaX18));

        // Price move sign (plaintext, uses public prices + side)
        bool priceGain = p.isLong ? (price >= p.entryPrice) : (price <= p.entryPrice);
        if (priceGain) {
            gainX18 = encMagX18;
            lossX18 = FHE.asEuint256(0);
        } else {
            gainX18 = FHE.asEuint256(0);
            lossX18 = encMagX18;
        }
    }

    /// @dev Funding buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _encFundingBucketsX18(
        Position storage p
    ) internal returns (euint256 gainX18, euint256 lossX18) {
        int256 dF = (p.isLong ? cumFundingLongX18 : cumFundingShortX18) - p.entryFundingX18;
        euint256 encMagX18 = FHE.mul(p.size, FHE.asEuint256(uint256(dF >= 0 ? dF : -dF)));

        bool fundingLoss = (dF >= 0);
        if (fundingLoss) {
            gainX18 = FHE.asEuint256(0);
            lossX18 = encMagX18;
        } else {
            gainX18 = encMagX18;
            lossX18 = FHE.asEuint256(0);
        }
    }

    /// @dev Build LHS/RHS (X18) for encrypted liquidation compare without negative ciphertexts:
    /// LHS = collateral*1e18 + totalGainsX18
    /// RHS = totalLossesX18 + requiredX18
    function _encEquityOperandsX18(
        Position storage p,
        uint256 price,
        euint256 encRequiredX18
    ) internal returns (euint256 lhsX18, euint256 rhsX18) {
        (euint256 priceGainX18, euint256 priceLossX18) = _encPriceBucketsX18(p, price);
        (euint256 fundGainX18,  euint256 fundLossX18)  = _encFundingBucketsX18(p);

        // Aggregate (encrypted, non-negative) + include entry price impact
        euint256 gainsX18  = FHE.add(priceGainX18, fundGainX18);
        gainsX18           = FHE.add(gainsX18,  p.encImpactEntryGainX18);

        euint256 lossesX18 = FHE.add(priceLossX18, fundLossX18);
        lossesX18          = FHE.add(lossesX18, p.encImpactEntryLossX18);

        // Operands
        euint256 collX18 = FHE.asEuint256(p.collateral * ONE_X18);
        lhsX18 = FHE.add(collX18, gainsX18);
        rhsX18 = FHE.add(lossesX18, encRequiredX18);
    }

    /// @dev Encrypted equity (X18), clamped to zero (no maintenance term here).
    /// equityX18 = max(0, collateral*1e18 + gainsX18 - lossesX18)
    function _encEquityOnlyX18(
        Position storage p,
        uint256 price
    ) internal returns (euint256) {
        (euint256 priceGainX18, euint256 priceLossX18) = _encPriceBucketsX18(p, price);
        (euint256 fundGainX18,  euint256 fundLossX18)  = _encFundingBucketsX18(p);

        // include entry price impact
        euint256 gainsX18  = FHE.add(priceGainX18, fundGainX18);
        gainsX18           = FHE.add(gainsX18,  p.encImpactEntryGainX18);

        euint256 lossesX18 = FHE.add(priceLossX18, fundLossX18);
        lossesX18          = FHE.add(lossesX18, p.encImpactEntryLossX18);

        euint256 collX18   = FHE.asEuint256(p.collateral * ONE_X18);
        euint256 lhs       = FHE.add(collX18, gainsX18);

        // equity = max(0, lhs - losses)
        ebool insolvent    = FHE.lt(lhs, lossesX18);
        euint256 diff      = FHE.sub(FHE.select(insolvent, lossesX18, lhs),
                                     FHE.select(insolvent, lhs,       lossesX18));
        // if insolvent => 0; else => diff
        return FHE.select(insolvent, FHE.asEuint256(0), diff);
    }

    function _setupSettlement(Position storage p, uint256 settlementPrice) internal {
        // Build encrypted equity at this price (X18), then request decrypt
        euint256 encEqX18 = _encEquityOnlyX18(p, settlementPrice);
        p.pendingEquityX18 = encEqX18;
        FHE.decrypt(p.pendingEquityX18);

        p.status = Status.AwaitingSettlement;
        p.settlementPrice = settlementPrice;

        FHE.allowThis(p.pendingEquityX18);
    }

    function _settle(uint256 positionId) internal {
        console.log("settling");
        Position storage p = positions[positionId];
        require(p.status == Status.AwaitingSettlement, "not awaiting settlement");

        (uint256 eqX18, bool ready) = FHE.getDecryptResultSafe(p.pendingEquityX18);
        require(ready, "equity not ready");

        // Gross payout in USDC (6d)
        uint256 payoutGross = eqX18 / ONE_X18;
        console.log("payoutGross:");
        console.log(payoutGross);

        // Close fee on payout
        uint256 fee = (payoutGross * CLOSE_FEE_BPS) / BPS_DIVISOR;
        console.log("fee:");
        console.log(fee);
        uint256 payoutNet = payoutGross > fee ? (payoutGross - fee) : 0;
        console.log("payoutNet:");
        console.log(payoutNet);

        // Transfer
        if (payoutNet > 0) {
            require(payoutNet <= usdcBalance, "pool insolvent");
            usdcBalance -= payoutNet;
            usdc.safeTransfer(p.owner, payoutNet);
        }

        // Update encrypted OI aggregates (remove size)
        if (p.isLong) {
            encLongOI = FHE.sub(encLongOI, p.size);
            emit EncryptedOIUpdated(true, false, positionId);
        } else {
            encShortOI = FHE.sub(encShortOI, p.size);
            emit EncryptedOIUpdated(false, false, positionId);
        }

        // Mark final status by cause
        p.status = (p.cause == CloseCause.Liquidation) ? Status.Liquidated : Status.Closed;

        emit PositionClosed(
            positionId,
            p.owner,
            int256(0), // pnl intentionally not emitted under encrypted-equity settlement
            payoutNet,
            p.status,
            p.settlementPrice,
            fee
        );

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
    }

    // ===============================
    // Price Impact helpers
    // ===============================

    /// @dev Compute L_eff (USD, 6d) from TVL and a public utilization proxy (|rate|).
    function _impactLiquidityScaleUSD() internal view returns (uint256 L) {
        uint256 base = (usdcBalance * IMPACT_TVL_FACTOR_BPS) / 10_000;
        if (base < IMPACT_MIN_LIQ_USD) base = IMPACT_MIN_LIQ_USD;

        uint256 absRate = fundingRatePerSecX18 >= 0 ? uint256(fundingRatePerSecX18) : uint256(-fundingRatePerSecX18);
        // norm in [0, 1e18]
        uint256 norm = (absRate >= MAX_ABS_FUNDING_RATE_PER_SEC_X18)
            ? 1e18
            : (absRate * 1e18) / MAX_ABS_FUNDING_RATE_PER_SEC_X18;

        // scale = 1 + beta * norm; L_eff = L_base / scale
        uint256 scaleX18 = 1e18 + (IMPACT_UTIL_BETA_X18 * norm) / 1e18;
        L = (base * 1e18) / scaleX18;
        if (L == 0) L = 1; // safety
    }

    /// @dev Plaintext K such that: impactX18 = encDelta * K
    /// K = (P0 * GAMMA_X18) / (2 * L * IMPACT_SCALER)
    function _impactKPlain(uint256 oraclePrice) internal view returns (uint256) {
        uint256 L = _impactLiquidityScaleUSD(); // 6d
        uint256 num = oraclePrice * IMPACT_GAMMA_X18; // 8d * 1e18 = 1e26
        uint256 den = 2 * L * IMPACT_SCALER;         // 2 * 1e6 * 1e14 = 2e20
        if (den == 0) return 0;
        return num / den; // ~1e6 scale; ensures final enc product is USDC X18
    }

    /// @dev Return |skew| (encrypted) and encrypted boolean "skew >= 0".
    function _encAbsSkewAndFlag() internal returns (euint256 encAbs, ebool skewGEZero) {
        skewGEZero = FHE.gte(encLongOI, encShortOI);
        euint256 encMax = FHE.select(skewGEZero, encLongOI, encShortOI);
        euint256 encMin = FHE.select(skewGEZero, encShortOI, encLongOI);
        encAbs = FHE.sub(encMax, encMin);
    }

    /// @dev Encode K as encrypted euint256; returns (K, isZero).
    function _impactKEnc(uint256 oraclePrice) internal returns (euint256 K, bool isZero) {
        uint256 kPlain = _impactKPlain(oraclePrice);
        if (kPlain == 0) {
            return (FHE.asEuint256(0), true);
        }
        return (FHE.asEuint256(kPlain), false);
    }
    
    /// @dev Build delta parts for entry impact using non-negative buckets.
    /// deltaPos => contributes to trader loss; deltaNeg => contributes to trader gain.
    function _encDeltaPartsForImpact(
        bool isLong,
        ebool skewGEZero,
        euint256 encSize,
        euint256 encAbsSkew
    ) internal returns (euint256 deltaPos, euint256 deltaNeg) {
        // Common terms: size^2 and 2*|skew|*size
        euint256 size2    = FHE.mul(encSize, encSize);
        euint256 twoAbs   = FHE.mul(encAbsSkew, FHE.asEuint256(2));
        euint256 twoSsize = FHE.mul(twoAbs, encSize);
    
        // Always non-negative part of (s±)^2 difference
        euint256 alwaysPos = FHE.add(size2, twoSsize);
    
        // Magnitude of (size^2 - 2|s|size)
        ebool size2Ge = FHE.gte(size2, twoSsize);
        euint256 diff = FHE.sub(
            FHE.select(size2Ge, size2,    twoSsize),
            FHE.select(size2Ge, twoSsize, size2)
        );
    
        // Route to positive/negative buckets based on side & skew sign
        if (isLong) {
            // long: skew>=0 => alwaysPos; skew<0 => +/- diff
            euint256 posIfGE = alwaysPos;
            euint256 posIfLT = FHE.select(size2Ge, diff, FHE.asEuint256(0));
            euint256 negIfLT = FHE.select(size2Ge, FHE.asEuint256(0), diff);
            deltaPos = FHE.select(skewGEZero, posIfGE, posIfLT);
            deltaNeg = FHE.select(skewGEZero, FHE.asEuint256(0), negIfLT);
        } else {
            // short: skew<0 => alwaysPos; skew>=0 => +/- diff
            euint256 posIfLT = alwaysPos;
            euint256 posIfGE = FHE.select(size2Ge, diff, FHE.asEuint256(0));
            euint256 negIfGE = FHE.select(size2Ge, FHE.asEuint256(0), diff);
            deltaPos = FHE.select(skewGEZero, posIfGE, posIfLT);
            deltaNeg = FHE.select(skewGEZero, negIfGE, FHE.asEuint256(0));
        }
    }
    
    /// @dev Compute entry impact buckets for this trade BEFORE OI is updated.
    /// Adds only entry impact (exit impact can be added similarly later).
    function _encImpactEntryBucketsAtOpenX18(
        bool isLong,
        euint256 encSize,
        uint256 oraclePrice
    ) internal returns (euint256 gainX18, euint256 lossX18) {
        (euint256 K, bool zeroK) = _impactKEnc(oraclePrice);
        if (zeroK) {
            // no impact when K == 0
            return (FHE.asEuint256(0), FHE.asEuint256(0));
        }
    
        // |skew| and skew sign
        (euint256 encAbsSkew, ebool skewGEZero) = _encAbsSkewAndFlag();
    
        // Split into non-negative buckets
        (euint256 deltaPos, euint256 deltaNeg) =
            _encDeltaPartsForImpact(isLong, skewGEZero, encSize, encAbsSkew);
    
        // impactX18 = delta * K; positive => trader loss, negative => trader gain
        lossX18 = FHE.mul(deltaPos, K);
        gainX18 = FHE.mul(deltaNeg, K);
    }
}
