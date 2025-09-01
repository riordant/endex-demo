// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import {IEncryptedPerpsNew} from "./IEncryptedPerpsNew.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "hardhat/console.sol";

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

contract SimpleEncryptedPerpsNew is IEncryptedPerpsNew {
    using SafeERC20 for IERC20;

    // -------- Constants --------
    uint256 public constant MAX_LEVERAGE_X = 5; // 5x
    uint256 public constant CLOSE_FEE_BPS = 10; // 0.1% close fee
    uint256 public constant BPS_DIVISOR = 10_000;

    // funding / math scales
    uint256 public constant ONE_X18 = 1e18;
    euint256 public immutable ENC_ONE_X18;
    uint256 public constant MAINT_MARGIN_BPS = 100; // 1%

    // funding rate cap and linear coefficient (tunable)
    euint256 public immutable FUNDING_K_X12; // scales encrypted skew to rate numerator
    uint256 public constant MAX_ABS_FUNDING_RATE_PER_SEC_X18 = 1e9; // 1e-9 per sec (~0.0864%/day)

    // Tokens and oracle
    IERC20 public immutable usdc; // 6 decimals
    IAggregatorV3 public immutable ethUsdFeed; // 8 decimals

    // LP accounting
    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;
    uint256 public usdcBalance; // pool USDC

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

    // funding request state
    bool    public fundingPending;
    uint64  public fundingEpoch;
    uint256 public fundingRequestedAt;
    euint256 private pendingRateNumeratorEnc; // |skew| * K (encrypted)
    euint256 private pendingSkewFlagEnc;      // 0/1 encrypted (longOI >= shortOI)

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

        // Compute sign flag first
        ebool condGE = FHE.gte(encLongOI, encShortOI); // true if long >= short

        // Select A = max, B = min (so A - B won't underflow)
        euint256 encA = FHE.select(condGE, encLongOI, encShortOI);
        euint256 encB = FHE.select(condGE, encShortOI, encLongOI);

        // encDelta = A - B (absolute skew magnitude, encrypted)
        euint256 encDelta = FHE.sub(encA, encB);

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
        (uint256 num,  bool r1) = FHE.getDecryptResultSafe(pendingRateNumeratorEnc); // |skew|*K (X? scale)
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

    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice,
        uint256 liquidationPrice
    ) external override {
        // Update funding indices first
        pokeFunding();

        // Encrypted size (cap leverage privately)
        euint256 _size = FHE.asEuint256(size_);
        euint256 max_size = FHE.asEuint256(collateral * MAX_LEVERAGE_X);
        euint256 size = FHE.select(FHE.gt(_size, max_size), max_size, _size);

        // Pull collateral
        require(collateral > 0, "collateral=0");
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        usdcBalance += collateral;

        // Get entry price
        (, int256 price,,,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");

        uint256 id = nextPositionId++;

        positions[id] = Position({
            owner: msg.sender,
            positionId: id,
            isLong: isLong,
            size: size,
            collateral: collateral,
            entryPrice: uint256(price),
            liquidationPrice: liquidationPrice,   // TODO: compute internally in future pass
            stopLossPrice: stopLossPrice,         // TODO: move to encrypted later
            takeProfitPrice: takeProfitPrice,     // TODO: move to encrypted later
            settlementPrice: 0,
            status: Status.Open,
            entryFundingX18: (isLong ? cumFundingLongX18 : cumFundingShortX18),
            pendingLiqFlagEnc: FHE.asEuint256(0),
            pendingLiqCheckPrice: 0,
            liqCheckPending: false
        });
        Position storage p = positions[id];

        // Update encrypted OI aggregates
        if (isLong) {
            encLongOI = FHE.add(encLongOI, size);
            emit EncryptedOIUpdated(true, true, id);
        } else {
            encShortOI = FHE.add(encShortOI, size);
            emit EncryptedOIUpdated(false, true, id);
        }

        // Permissions for size ciphertext
        FHE.allowThis(p.size);
        FHE.allowSender(p.size);

        FHE.allowThis(p.pendingLiqFlagEnc);
        FHE.allowSender(p.pendingLiqFlagEnc);

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);

        emit PositionOpened(id, msg.sender, isLong, size, collateral, uint256(price));
    }

    function closePosition(uint256 positionId) external override {
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "not owner");
        require(p.status == Status.Open, "not open");

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

            if (hitTp || hitSl) {
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

    /// @dev Step 1: compute encrypted (equity < maintenance) by comparing LHS/RHS (no negatives), request decrypt of 0/1 flag.
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
            if (!p.liqCheckPending || p.status != Status.Open) continue;

            (uint256 flag, bool ready) = FHE.getDecryptResultSafe(p.pendingLiqFlagEnc);
            if (!ready) continue;

            p.liqCheckPending = false;

            if (flag == 1) {
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

    /// @dev Price PnL buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    /// gainX18/lossX18 are encrypted and safe for euint256 arithmetic.
    function _encPriceBucketsX18(
        Position storage p,
        uint256 price
    ) internal returns (euint256 gainX18, euint256 lossX18) {
        // ratioX18 = 1e18 * P / E  (plaintext ratio for sign; encrypted magnitude below)
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
    /// Uses side-specific cumulative index so "loss" is simply (dF >= 0).
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
    
        // Aggregate (encrypted, non-negative)
        euint256 gainsX18  = FHE.add(priceGainX18, fundGainX18);
        euint256 lossesX18 = FHE.add(priceLossX18, fundLossX18);
    
        // Operands
        euint256 collX18 = FHE.asEuint256(p.collateral * ONE_X18);
        lhsX18 = FHE.add(collX18, gainsX18);
        rhsX18 = FHE.add(lossesX18, encRequiredX18);
    }

    function _setupSettlement(Position storage p, uint256 settlementPrice) internal {
        FHE.decrypt(p.size); // request async size decrypt
        p.status = Status.AwaitingSettlement;
        p.settlementPrice = settlementPrice;
        FHE.allowThis(p.size);
    }

    function _settle(uint256 positionId) internal {
        Position storage p = positions[positionId];
        require(p.status == Status.AwaitingSettlement, "not awaiting settlement");

        // Read decrypted size
        (uint256 size, bool sizeReady) = FHE.getDecryptResultSafe(p.size);
        require(sizeReady, "Size not yet decrypted");

        uint256 price = p.settlementPrice;

        // Price PnL (plaintext, using decrypted size)
        int256 pnl;
        if (p.isLong) {
            pnl = (int256(size) * (int256(price) - int256(p.entryPrice))) / int256(p.entryPrice);
        } else {
            pnl = (int256(size) * (int256(p.entryPrice) - int256(price))) / int256(p.entryPrice);
        }

        // Funding at settlement
        int256 fundingDeltaX18 = (p.isLong ? cumFundingLongX18 : cumFundingShortX18) - p.entryFundingX18;
        int256 fundingUSDC = (int256(size) * fundingDeltaX18) / int256(ONE_X18);

        // Gross equity = collateral + pnl - funding (fundingUSDC may be negative => adds)
        int256 payoutGross = int256(p.collateral) + pnl - fundingUSDC;
        if (payoutGross < 0) payoutGross = 0;

        // Close fee on payout
        uint256 fee = (uint256(payoutGross) * CLOSE_FEE_BPS) / BPS_DIVISOR;
        int256 payoutNet = payoutGross - int256(fee);

        // Transfer
        if (payoutNet > 0) {
            require(uint256(payoutNet) <= usdcBalance, "pool insolvent");
            usdcBalance -= uint256(payoutNet);
            usdc.safeTransfer(p.owner, uint256(payoutNet));
        }

        // Update encrypted OI aggregates (remove size)
        if (p.isLong) {
            encLongOI = FHE.sub(encLongOI, p.size);
            emit EncryptedOIUpdated(true, false, positionId);
        } else {
            encShortOI = FHE.sub(encShortOI, p.size);
            emit EncryptedOIUpdated(false, false, positionId);
        }

        // Mark status
        p.status = payoutGross == 0 && (p.isLong ? price <= p.liquidationPrice : price >= p.liquidationPrice)
            ? Status.Liquidated
            : Status.Closed;

        emit PositionClosed(positionId, p.owner, pnl, uint256(payoutNet < 0 ? int256(0) : payoutNet), p.status, price, fee);

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
    }
}
