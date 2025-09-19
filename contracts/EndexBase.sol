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

contract EndexBase is IEndex {
    using SafeERC20 for IERC20;

    // -------- Constants --------
    uint256 public constant MAX_LEVERAGE_X   = 5;       // 5x
    uint256 public constant CLOSE_FEE_BPS    = 10;      // 0.1% close fee
    uint256 public constant BPS_DIVISOR      = 10_000;

    // Funding / math scales
    uint256  public constant ONE_X18          = 1e18;
    uint256  public constant MAINT_MARGIN_BPS = 100;      // 1%
    uint256  public constant MIN_NOTIONAL_USDC = 10e6;    // 10 USDC (6d)

    // Funding rate clamp
    uint256  public constant MAX_ABS_FUNDING_RATE_PER_SEC_X18 = 1e9; // ~0.0864%/day

    // ===== Price Impact Params (ETH-only tuning) =====
    uint256 public constant IMPACT_GAMMA_X18       = 3e15;        // 0.003 (dimensionless)
    uint256 public constant IMPACT_TVL_FACTOR_BPS  = 5000;        // 50% of pool balance
    uint256 public constant IMPACT_MIN_LIQ_USD     = 500_000e6;   // 500k USDC floor (6d)
    uint256 public constant IMPACT_UTIL_BETA_X18   = 1e18;        // strengthen impact under high |rate|
    uint256 private constant IMPACT_SCALER         = 1e14;        // units helper

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

    // -------- Funding state (ENCRYPTED) --------
    // signed, per second, X18
    eint256  public fundingRatePerSecX18;
    // signed cumulative indices, X18
    eint256  public cumFundingLongX18;
    eint256  public cumFundingShortX18;
    uint256  public lastFundingUpdate;

    // -------- Encrypted OI aggregates (never decrypted) --------
    euint256 public encLongOI;  // sum of encrypted long notionals (1e6)
    euint256 public encShortOI; // sum of encrypted short notionals (1e6)

    // ===============================
    // Constructor
    // ===============================

    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed) {
        usdc = _usdc;
        ethUsdFeed = _ethUsdFeed;

        lastFundingUpdate = block.timestamp;

        encLongOI = FHE.asEuint256(0);
        encShortOI = FHE.asEuint256(0);

        // init encrypted signed states as zero
        fundingRatePerSecX18 = eint256({ sign: _ebTrue(), val: FHE.asEuint256(0) }); // +0
        cumFundingLongX18    = eint256({ sign: _ebTrue(), val: FHE.asEuint256(0) });
        cumFundingShortX18   = eint256({ sign: _ebTrue(), val: FHE.asEuint256(0) });

        // Permissions for ciphertexts used by this contract
        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        _allowEint256(fundingRatePerSecX18);
        _allowEint256(cumFundingLongX18);
        _allowEint256(cumFundingShortX18);
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

    function lpSharesOf(address user) external view returns (uint256) {
        return lpShares[user];
    }
    
    function totalLpSharesView() external view returns (uint256) {
        return totalLpShares;
    }
    
    function usdcBalanceView() external view returns (uint256) {
        return usdcBalance;
    }

    // ===============================
    // FUNDING (all encrypted)
    // ===============================

    /// @notice Accrue cumulative funding using current fundingRatePerSecX18 (encrypted).
    function _pokeFunding() internal {
        uint256 nowTs = block.timestamp;
        if (nowTs == lastFundingUpdate) return;

        uint256 dt = nowTs - lastFundingUpdate;
        lastFundingUpdate = nowTs;

        uint initialGas = gasleft();
        euint256 bump = FHE.mul(fundingRatePerSecX18.val, FHE.asEuint256(dt));
        console.log("mul gas used: ", initialGas - gasleft());

        // long side accrues +rate; short side accrues -rate
        initialGas = gasleft();
        _encAddSigned(cumFundingLongX18,  fundingRatePerSecX18.sign,          bump);
        console.log("encAddSigned gas used: ", initialGas - gasleft());
        _encAddSigned(cumFundingShortX18, _ebNot(fundingRatePerSecX18.sign),  bump);

        _allowFunding();

        // Keep legacy event signature for compatibility (values meaningless now).
        emit FundingAccrued(0, 0, 0, nowTs);
    }

    /// @dev Derive encrypted fundingRatePerSecX18 from encrypted skew and clamp |rate|.
    /// @dev Call this AFTER any change to encLongOI/encShortOI.
    function _setFundingRateFromSkew() internal {
        // abs skew and sign
        ebool skewGE = FHE.gte(encLongOI, encShortOI);
        euint256 encMax = FHE.select(skewGE, encLongOI, encShortOI);
        euint256 encMin = FHE.select(skewGE, encShortOI, encLongOI);
        euint256 absSkew = FHE.sub(encMax, encMin);

        // scale skew to rate magnitude; use 1e6 factor so units match your old /1e6 convention
        euint256 rateMag = FHE.mul(absSkew, FHE.asEuint256(1e6));

        // clamp
        ebool over = FHE.gte(rateMag, FHE.asEuint256(MAX_ABS_FUNDING_RATE_PER_SEC_X18));
        euint256 magClamped = FHE.select(over, FHE.asEuint256(MAX_ABS_FUNDING_RATE_PER_SEC_X18), rateMag);

        fundingRatePerSecX18 = eint256({ sign: skewGE, val: magClamped });
        _allowFunding();
    }

    // ===============================
    // TRADING API
    // ===============================
    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice
    ) external virtual {
        _openPosition(
            isLong,
            size_,
            collateral,
            stopLossPrice,
            takeProfitPrice
        );
    }

    function _openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice
    ) internal {
        uint initialGas = gasleft();
        // Accrue funding before opening (with previous rate)
        _pokeFunding();
        console.log("pokeFunding gas used: ", initialGas - gasleft());

        // Price & collateral checks
        (, int256 price,,,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");
        require(collateral > 0, "collateral=0");

        // Clamp encrypted requested size to [MIN_NOTIONAL_USDC, collateral * MAX_LEVERAGE_X]
        initialGas = gasleft();
        euint256 size = _clampEncryptedSize(size_, collateral);
        console.log("clamp gas used: ", initialGas - gasleft());

        // Pull collateral
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        usdcBalance += collateral;

        uint256 id = nextPositionId++;

        // --- Entry price impact buckets (encrypted) BEFORE updating OI ---
        initialGas = gasleft();
        (euint256 impGainX18, euint256 impLossX18) =
            _encImpactEntryBucketsAtOpenX18(isLong, size, uint256(price));
        console.log("encBuckets gas used: ", initialGas - gasleft());

        // Snapshot entry funding (encrypted signed)
        eint256 memory snap = isLong ? cumFundingLongX18 : cumFundingShortX18;

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
            cause: CloseCause.UserClose, // default; may be overwritten later
            entryFundingX18: snap,
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

        // Update funding rate for future accruals
        initialGas = gasleft();
        _setFundingRateFromSkew();
        console.log("set funding rate gas used: ", initialGas - gasleft());

        // Permissions for ciphertexts
        initialGas = gasleft();
        FHE.allowSender(p.size);
        FHE.allowGlobal(p.pendingLiqFlagEnc);

        FHE.allowThis(p.size);
        FHE.allowThis(p.pendingLiqFlagEnc);
        FHE.allowThis(p.encImpactEntryGainX18);
        FHE.allowThis(p.encImpactEntryLossX18);
        FHE.allowThis(p.pendingEquityX18);

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        console.log("set allowance gas used: ", initialGas - gasleft());

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

    function requestLiqChecks(uint256[] calldata positionIds) external override {
        // Keep funding fresh for equity calc
        _pokeFunding();
        uint256 price = _markPrice();

        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage p = positions[positionIds[i]];
            if (p.status != Status.Open) continue;

            // required = size * MAINT_MARGIN_BPS * 1e14 (BPS -> X18)
            euint256 encReqX18 = FHE.mul(p.size, FHE.asEuint256(MAINT_MARGIN_BPS * 1e14));

            (euint256 lhs, euint256 rhs) = _encEquityOperandsForLiqX18(p, price, encReqX18);

            // needLiq = (lhs < rhs)
            ebool needLiq = FHE.lt(lhs, rhs);

            // 0/1 encrypted flag and request decrypt
            p.pendingLiqFlagEnc = FHE.select(needLiq, FHE.asEuint256(1), FHE.asEuint256(0));
            p.pendingLiqCheckPrice = price;
            p.liqCheckPending = true;
            FHE.decrypt(p.pendingLiqFlagEnc);

            FHE.allowThis(p.pendingLiqFlagEnc);
            FHE.allowThis(p.size);
        }
    }

    function finalizeLiqChecks(uint256[] calldata positionIds) external override {
        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage p = positions[positionIds[i]];
            if (!p.liqCheckPending || p.status != Status.Open) continue;

            (uint256 flag, bool ready) = FHE.getDecryptResultSafe(p.pendingLiqFlagEnc);
            if (!ready) continue;

            p.liqCheckPending = false;

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

    // ---------- Encrypted-boolean helpers (no plain bool branching) ----------
    
    // Encrypted true/false
    function _ebTrue() internal returns (ebool) {
        // 1 >= 0  => true
        return FHE.gte(FHE.asEuint256(1), FHE.asEuint256(0));
    }
    function _ebFalse() internal returns (ebool) {
        // 0 < 0   => false
        return FHE.lt(FHE.asEuint256(0), FHE.asEuint256(0));
    }
    
    // Map ebool <-> euint256 {false=>0, true=>1}
    function _ebToUint(ebool b) internal returns (euint256) {
        return FHE.select(b, FHE.asEuint256(1), FHE.asEuint256(0));
    }
    function _uintToEb(euint256 u) internal returns (ebool) {
        // u >= 1 => true; u == 0 => false
        return FHE.gte(u, FHE.asEuint256(1));
    }
    
    // NOT(b) using select+compare only
    function _ebNot(ebool b) internal returns (ebool) {
        // if b then 0 else 1
        euint256 inv = FHE.select(b, FHE.asEuint256(0), FHE.asEuint256(1));
        return FHE.gte(inv, FHE.asEuint256(1));
    }
    
    // (a == b) without eq/xor: diff = |a-b| on {0,1}; diff<1 => equal
    function _ebEqual(ebool a, ebool b) internal returns (ebool) {
        euint256 ua  = _ebToUint(a);
        euint256 ub  = _ebToUint(b);
        ebool    ge  = FHE.gte(ua, ub);
        euint256 diff = FHE.sub(
            FHE.select(ge, ua, ub),
            FHE.select(ge, ub, ua)
        );
        return FHE.lt(diff, FHE.asEuint256(1));
    }
    
    // Select between two ebools with encrypted condition
    function _ebSelect(ebool cond, ebool x, ebool y) internal returns (ebool) {
        euint256 ux = _ebToUint(x);
        euint256 uy = _ebToUint(y);
        euint256 u  = FHE.select(cond, ux, uy);
        return _uintToEb(u);
    }

    // Generic signed add on pairs (returns new sign,val)
    function _encAddSignedPair(
        ebool aSign, euint256 aVal,
        ebool bSign, euint256 bVal
    ) internal returns (ebool outSign, euint256 outVal) {
        euint256 sum = FHE.add(aVal, bVal);
        ebool    aGeB = FHE.gte(aVal, bVal);
        euint256 diff = FHE.sub(
            FHE.select(aGeB, aVal, bVal),
            FHE.select(aGeB, bVal, aVal)
        );
    
        // sameSign = (aSign == bSign)
        ebool sameSign = _ebEqual(aSign, bSign);
    
        // val = same ? sum : diff
        uint initialGas = gasleft();
        outVal  = FHE.select(sameSign, sum, diff);
        console.log("select used: ", initialGas - gasleft());
        // sign = same ? aSign : (aGeB ? aSign : bSign)
        outSign = _ebSelect(sameSign, aSign, _ebSelect(aGeB, aSign, bSign));
    }
    
    // r = r (+/-) (bSign ? +bVal : -bVal)
    function _encAddSigned(eint256 storage r, ebool bSign, euint256 bVal) internal {
        (ebool s, euint256 v) = _encAddSignedPair(r.sign, r.val, bSign, bVal);
        r.sign = s;
        r.val  = v;
    }
    
    // a - b = a + (-b)
    function _encSubSigned(eint256 memory a, eint256 memory b) internal returns (eint256 memory c) {
        ebool negBsign = _ebNot(b.sign);
        (c.sign, c.val) = _encAddSignedPair(a.sign, a.val, negBsign, b.val);
    }
    
    // allow eint256 (sign + val)
    function _allowEint256(eint256 storage a) internal {
        FHE.allowThis(a.sign);
        FHE.allowThis(a.val);
    }

    // allow all encrypted funding vars
    function _allowFunding() internal {
        _allowEint256(fundingRatePerSecX18);
        _allowEint256(cumFundingLongX18);
        _allowEint256(cumFundingShortX18);
    }

    // ---------- Buckets (price, funding) ----------

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
        // dF = currentCum - entryFunding (encrypted signed)
        eint256 memory cur = p.isLong ? cumFundingLongX18 : cumFundingShortX18;
        eint256 memory dF  = _encSubSigned(cur, p.entryFundingX18);

        // magnitude
        euint256 magX18 = FHE.mul(p.size, dF.val);

        // For long: dF >= 0 => loss; For short: same rule holds because we snapshot side-specific index.
        // Put magnitude to loss if dF.sign==true (>=0), else to gain.
        if (true) {
            ebool lossFlag = dF.sign;
            lossX18 = FHE.select(lossFlag, magX18, FHE.asEuint256(0));
            gainX18 = FHE.select(lossFlag, FHE.asEuint256(0), magX18);
        }
    }

    // ---------- Price Impact (entry & exit) ----------

    /// @dev Compute L_eff (USD, 6d) from TVL and a public utilization proxy (|rate|), fully encrypted.
    function _impactLiquidityScaleUSD_enc() internal returns (euint256 L) {
        // base = max(usdcBalance * FACTOR_BPS / 1e4, MIN_LIQ)
        uint256 basePlain = (usdcBalance * IMPACT_TVL_FACTOR_BPS) / 10_000;
        if (basePlain < IMPACT_MIN_LIQ_USD) basePlain = IMPACT_MIN_LIQ_USD;
        euint256 base = FHE.asEuint256(basePlain);

        // absRate = |fundingRatePerSecX18|
        euint256 absRate = fundingRatePerSecX18.val;

        // norm in [0, 1e18] = min(1e18, absRate * 1e18 / MAX_ABS)
        euint256 num   = FHE.mul(absRate, FHE.asEuint256(1e18));
        euint256 norm  = FHE.div(num, FHE.asEuint256(MAX_ABS_FUNDING_RATE_PER_SEC_X18));
        ebool cap      = FHE.gte(norm, FHE.asEuint256(1e18));
        euint256 normC = FHE.select(cap, FHE.asEuint256(1e18), norm);

        // scaleX18 = 1e18 + beta * normC / 1e18
        euint256 betaNorm = FHE.mul(FHE.asEuint256(IMPACT_UTIL_BETA_X18), normC);
        euint256 betaTerm = FHE.div(betaNorm, FHE.asEuint256(1e18));
        euint256 scaleX18 = FHE.add(FHE.asEuint256(1e18), betaTerm);

        // L = base * 1e18 / scaleX18
        euint256 numL = FHE.mul(base, FHE.asEuint256(1e18));
        L = FHE.div(numL, scaleX18);
    }

    /// @dev Encrypted K: K = (P0 * GAMMA_X18) / (2 * L * IMPACT_SCALER)
    function _impactKEnc(uint256 oraclePrice) internal returns (euint256 K) {
        // numerator is plaintext -> encrypt once
        uint256 numPlain = oraclePrice * IMPACT_GAMMA_X18; // 8d * 1e18 ~ 1e26
        euint256 num = FHE.asEuint256(numPlain);

        euint256 L = _impactLiquidityScaleUSD_enc();
        euint256 den1 = FHE.mul(L, FHE.asEuint256(2));
        euint256 den = FHE.mul(den1, FHE.asEuint256(IMPACT_SCALER));

        K = FHE.div(num, den); // if num<den, K→0 automatically
    }

    /// @dev Return |skew| (encrypted) and encrypted boolean "skew >= 0".
    function _encAbsSkewAndFlag() internal returns (euint256 encAbs, ebool skewGEZero) {
        skewGEZero = FHE.gte(encLongOI, encShortOI);
        euint256 encMax = FHE.select(skewGEZero, encLongOI, encShortOI);
        euint256 encMin = FHE.select(skewGEZero, encShortOI, encLongOI);
        encAbs = FHE.sub(encMax, encMin);
    }

    /// @dev Build delta parts for entry/exit impact using non-negative buckets.
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

    /// @dev Entry impact buckets at open (before OI update).
    function _encImpactEntryBucketsAtOpenX18(
        bool isLong,
        euint256 encSize,
        uint256 oraclePrice
    ) internal returns (euint256 gainX18, euint256 lossX18) {
        euint256 K = _impactKEnc(oraclePrice);

        (euint256 encAbsSkew, ebool skewGEZero) = _encAbsSkewAndFlag();

        (euint256 deltaPos, euint256 deltaNeg) =
            _encDeltaPartsForImpact(isLong, skewGEZero, encSize, encAbsSkew);

        // impactX18 = delta * K; positive => trader loss, negative => trader gain
        lossX18 = FHE.mul(deltaPos, K);
        gainX18 = FHE.mul(deltaNeg, K);
    }

    /// @dev Exit impact buckets at close (before OI is removed).
    /// For exit, the trade is in the OPPOSITE direction with size = position.size.
    function _encImpactExitBucketsAtCloseX18(
        Position storage p,
        uint256 oraclePrice
    ) internal returns (euint256 gainX18, euint256 lossX18) {
        euint256 K = _impactKEnc(oraclePrice);

        (euint256 encAbsSkew, ebool skewGEZero) = _encAbsSkewAndFlag();

        // Exit trade direction is opposite of position side
        bool exitIsLong = !p.isLong;

        (euint256 deltaPos, euint256 deltaNeg) =
            _encDeltaPartsForImpact(exitIsLong, skewGEZero, p.size, encAbsSkew);

        lossX18 = FHE.mul(deltaPos, K);
        gainX18 = FHE.mul(deltaNeg, K);
    }

    // ---------- Equity builders ----------

    /// @dev Build LHS/RHS (X18) for encrypted liquidation compare without negative ciphertexts.
    /// Uses ONLY entry impact (exit impact is NOT included during liq checks).
    function _encEquityOperandsForLiqX18(
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

    /// @dev Encrypted equity (X18), clamped to zero. Includes **exit impact** at settlement.
    /// equityX18 = max(0, collateral*1e18 + gainsX18 - lossesX18)
    function _encEquityOnlyX18(
        Position storage p,
        uint256 price
    ) internal returns (euint256) {
        (euint256 priceGainX18, euint256 priceLossX18) = _encPriceBucketsX18(p, price);
        (euint256 fundGainX18,  euint256 fundLossX18)  = _encFundingBucketsX18(p);

        // exit impact at settlement
        (euint256 exitGainX18, euint256 exitLossX18) = _encImpactExitBucketsAtCloseX18(p, price);

        // include entry + exit price impact
        euint256 gainsX18  = FHE.add(priceGainX18, fundGainX18);
        gainsX18           = FHE.add(gainsX18,  p.encImpactEntryGainX18);
        gainsX18           = FHE.add(gainsX18,  exitGainX18);

        euint256 lossesX18 = FHE.add(priceLossX18, fundLossX18);
        lossesX18          = FHE.add(lossesX18, p.encImpactEntryLossX18);
        lossesX18          = FHE.add(lossesX18, exitLossX18);

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
        // Accrue funding to now
        _pokeFunding();

        // Build encrypted equity at this price (X18) including exit impact, then request decrypt
        euint256 encEqX18 = _encEquityOnlyX18(p, settlementPrice);
        p.pendingEquityX18 = encEqX18;
        FHE.decrypt(p.pendingEquityX18);

        p.status = Status.AwaitingSettlement;
        p.settlementPrice = settlementPrice;

        FHE.allowThis(p.pendingEquityX18);
    }

    function _settle(uint256 positionId) internal {
        Position storage p = positions[positionId];
        require(p.status == Status.AwaitingSettlement, "not awaiting settlement");

        (uint256 eqX18, bool ready) = FHE.getDecryptResultSafe(p.pendingEquityX18);
        require(ready, "equity not ready");

        // Gross payout in USDC (6d)
        uint256 payoutGross = eqX18 / ONE_X18;

        // Close fee on payout
        uint256 fee = (payoutGross * CLOSE_FEE_BPS) / BPS_DIVISOR;
        uint256 payoutNet = payoutGross > fee ? (payoutGross - fee) : 0;

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

        // After OI change, update funding rate for future accruals
        _setFundingRateFromSkew();

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
}
