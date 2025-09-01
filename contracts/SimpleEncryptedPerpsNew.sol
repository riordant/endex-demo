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

    // NEW: funding / math scales
    uint256 public constant ONE_X18 = 1e18;
    euint256 public immutable ENC_ONE_X18;
    uint256 public constant MAINT_MARGIN_BPS = 100; // 1% maintenance margin requirement (tunable)

    // NEW: funding rate cap and linear coefficient (tunable, placeholder values)
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

    // -------- NEW: Funding state --------
    int256  public fundingRatePerSecX18; // signed, per second, X18
    int256  public cumFundingLongX18;    // signed cumulative index X18
    int256  public cumFundingShortX18;   // signed cumulative index X18
    uint256 public lastFundingUpdate;

    // -------- NEW: Encrypted OI aggregates (never decrypted) --------
    euint256 private encLongOI;  // sum of encrypted long notionals (1e6)
    euint256 private encShortOI; // sum of encrypted short notionals (1e6)

    // funding request state
    bool    public fundingPending;
    uint64  public fundingEpoch;
    uint256 public fundingRequestedAt;
    euint256 private pendingRateNumeratorEnc; // from encrypted skew * K
    euint256 private pendingSkewFlagEnc;      // 0/1 encrypted (longOI >= shortOI)

    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed) {
        usdc = _usdc;
        ethUsdFeed = _ethUsdFeed;

        // initialize funding timestamps and encrypted OI
        lastFundingUpdate = block.timestamp;
        encLongOI = FHE.asEuint256(0);
        encShortOI = FHE.asEuint256(0);
        FUNDING_K_X12 = FHE.asEuint256(1e12);
        ENC_ONE_X18 = FHE.asEuint256(ONE_X18);
        pendingRateNumeratorEnc = FHE.asEuint256(0);

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        FHE.allowThis(pendingRateNumeratorEnc);
        FHE.allowThis(FUNDING_K_X12);
        FHE.allowThis(ENC_ONE_X18);
    }

    // ===============================
    // LP FUNCTIONS (unchanged)
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
        console.log("dt:");
        console.logInt(dt);
        // long side accrues +rate; short side accrues -rate (mirror)
        cumFundingLongX18  += fundingRatePerSecX18 * dt;
        cumFundingShortX18 -= fundingRatePerSecX18 * dt;

        console.log("cumFundingShortX18:");
        console.logInt(cumFundingShortX18);
        lastFundingUpdate = nowTs;

        emit FundingAccrued(fundingRatePerSecX18, cumFundingLongX18, cumFundingShortX18, nowTs);

        console.log("done pokeFunding");
    }

    /// @dev Request to compute funding rate from encrypted skew (encLongOI - encShortOI).
    /// Produces an encrypted numerator to be decrypted off-chain; final scaling/clamp in commit.
    function requestFundingRateFromSkew() external {
        require(!fundingPending, "funding: pending");
        pokeFunding(); // accrue with old rate up to now
    
        // encSkew = encLongOI - encShortOI
        euint256 encSkew = FHE.sub(encLongOI, encShortOI);
    
        // numerator = encSkew * K (encrypted)
        pendingRateNumeratorEnc = FHE.mul(encSkew, FUNDING_K_X12);
    
        // sign flag: (encLongOI >= encShortOI) ? 1 : 0  (encrypted)
        ebool condGE = FHE.gte(encLongOI, encShortOI);
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

    /// @dev Finalize funding rate: read decrypted numerator, infer sign from long vs short totals, scale & clamp.
    /// NOTE: Because euint256 is unsigned, we infer sign by comparing encLongOI and encShortOI (via a small extra decrypt).
    /// If you prefer, you can request two numerators (pos/neg) and subtract plaintext values instead.
    function commitFundingRate(uint64 epoch) external {
        require(fundingPending && epoch == fundingEpoch, "funding: no pending/epoch");
    
        // read both decrypt results (must be ready)
        (uint256 num,  bool r1) = FHE.getDecryptResultSafe(pendingRateNumeratorEnc);
        (uint256 flag, bool r2) = FHE.getDecryptResultSafe(pendingSkewFlagEnc);
        require(r1 && r2, "funding: not ready");
    
        // signed numerator from flag
        int256 signedNum = (flag == 1) ? int256(num) : -int256(num);
    
        // scale to per-second X18 (K chosen so /1e6 returns X18 here)
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
        // optional: zero out to free
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
        // normal heartbeat guard
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

            // NOTE: liquidation now handled via encrypted trigger in a separate 2-step flow
            // (requestLiqChecks -> finalizeLiqChecks). We keep this function lean to avoid
            // mixing async decrypts here.
        }
    }

    function getPosition(uint256 positionId) external view override returns (Position memory) {
        return positions[positionId];
    }

    // ===============================
    // ENCRYPTED LIQUIDATION TRIGGER
    // ===============================

    /// @dev Step 1: compute encrypted (equity < maintenance) and request decrypt of 0/1 flag.
    function requestLiqChecks(uint256[] calldata positionIds) external override {
        pokeFunding(); // keep funding fresh for equity calc
        uint256 price = _markPrice();

        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage p = positions[positionIds[i]];
            if (p.status != Status.Open) continue;

            // encEquityX18 = collateral*1e18 + encPnL_X18 - encFundingAccrued_X18
            euint256 encEquityX18 = _encEquityX18(p, price);

            // encReq = size * MAINT_MARGIN_BPS * 1e14 (BPS -> X18)
            euint256 encMaintMarginBPS = FHE.asEuint256(MAINT_MARGIN_BPS * 1e14);
            euint256 encReq = FHE.mul(p.size, encMaintMarginBPS);

            // needLiq = (equity < required)
            ebool needLiq = FHE.lt(encEquityX18, encReq);

            // turn into 0/1 encrypted flag and request decrypt
            p.pendingLiqFlagEnc = FHE.select(needLiq, FHE.asEuint256(1), FHE.asEuint256(0));
            p.pendingLiqCheckPrice = price;
            p.liqCheckPending = true;
            console.log("decrypt p.pendingLiqFlagEnc..");
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

    /// @dev Build encrypted equity (X18) including funding, without revealing size.
    function _encEquityX18(Position storage p, uint256 price) internal returns (euint256) {
        // ratioX18 = price/entry * 1e18
        euint256 encRatioX18 = FHE.asEuint256((price * ONE_X18) / p.entryPrice);

        // encPnL_X18:
        // long: size*(ratioX18 - 1e18)
        // short: size*(1e18 - ratioX18)
        euint256 termA = FHE.mul(p.size, encRatioX18);
        euint256 termB = FHE.mul(p.size, ENC_ONE_X18);
        euint256 encPnlX18 = p.isLong ? FHE.sub(termA, termB) : FHE.sub(termB, termA);

        // fundingDeltaX18 (signed)
        int256 dF = (p.isLong ? cumFundingLongX18 : cumFundingShortX18) - p.entryFundingX18;

        // encFunding_X18 = size * |dF|
        euint256 encAbsDF = FHE.asEuint256(uint256(dF >= 0 ? dF : -dF));
        euint256 encFundingX18 = FHE.mul(p.size, encAbsDF);

        // equityX18 = collateral*1e18 + encPnL_X18 +/- encFunding_X18 (subtract if dF >= 0, else add)
        euint256 collX18 = FHE.asEuint256(p.collateral * ONE_X18);

        euint256 encEquityX18 = FHE.add(collX18, encPnlX18);
        encEquityX18 = (dF >= 0) ? FHE.sub(encEquityX18, encFundingX18)
                                 : FHE.add(encEquityX18, encFundingX18);

        FHE.allowThis(ENC_ONE_X18);

        return encEquityX18;
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

        // Plaintext PnL using decrypted size (prices 8d, size 6d) -> normalize
        int256 pnl;
        if (p.isLong) {
            pnl = (int256(size) * (int256(price) - int256(p.entryPrice))) / int256(p.entryPrice);
        } else {
            pnl = int256(size) * (int256(p.entryPrice) - int256(price)) / int256(p.entryPrice);
        }

        // Funding at settlement
        // fundingUSDC = size * ((cumFundingSide - entryFunding) / 1e18)
        int256 fundingDeltaX18 = (p.isLong ? cumFundingLongX18 : cumFundingShortX18) - p.entryFundingX18;
        int256 fundingUSDC = (int256(size) * fundingDeltaX18) / int256(ONE_X18);

        // Gross equity = collateral + pnl - funding (fundingUSDC may be negative => adds)
        int256 payoutGross = int256(p.collateral) + pnl - fundingUSDC;
        if (payoutGross < 0) payoutGross = 0;

        // Close fee on payout
        uint256 fee = (uint256(payoutGross) * CLOSE_FEE_BPS) / BPS_DIVISOR;
        int256 payoutNet = payoutGross - int256(fee);

        // Update pool balance and transfer
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
