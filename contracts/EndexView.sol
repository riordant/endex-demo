// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

/// @title EndexView
/// @notice Privacy-aware view/publish utilities layered on Endex:
///         - Funding rate (rounded, cadence gated, 2-step decrypt)
///         - Impact grid (rounded bps, cadence gated, 2-step decrypt)
///         - Per-request impact estimate (rounded bps, per-user gated, 2-step decrypt)
abstract contract EndexView is EndexBase {
    // ========= Cadence config =========
    uint256 public constant FUNDING_PUBLISH_INTERVAL = 10 minutes;
    uint256 public constant IMPACT_PUBLISH_INTERVAL  = 10 minutes;

    // Funding rounding: 0.1 bp / hour => step per second in X18
    // 0.1 bp/hr = 1e-5 per hour; per second = 1e-5 / 3600
    // stepX18 = 1e18 * 1e-5 / 3600 = 1e18 / 360_000_000 ≈ 2_777_777_777
    uint256 private constant _FUND_STEP_X18 = 2_777_777_777;

    // 1 bp in X18 is 1e14; half-bp is 5e13
    uint256 private constant _ONE_BP_X18  = 1e14;
    uint256 private constant _HALF_BP_X18 = 5e13;

    // ========= Funding (rounded public) =========
    int256  public lastFundingRatePerSecRoundedX18;
    uint256 public lastFundingPublishAt;

    // pending encrypts for funding publish (rounded magnitude + sign01)
    bool     private _fundingPending;
    euint256 private _fundingMagRoundedEnc;
    euint256 private _fundingSign01Enc;

    event FundingRateRequested(uint256 timestamp);
    event FundingRateUpdated(int256 ratePerSecRoundedX18, uint256 timestamp);


    constructor(IERC20 _usdc, IAggregatorV3 _feed)
        EndexBase(_usdc, _feed)
    {}

    /// @notice Step 1: stage encrypted rounding of the funding rate and request decrypt (cadence-gated).
    function requestFundingRatePublish() public {
        uint256 nowTs = block.timestamp;
        require(nowTs >= lastFundingPublishAt + FUNDING_PUBLISH_INTERVAL, "FR: cadence");
        require(!_fundingPending, "FR: pending");

        // Build rounded magnitude on ciphertexts: round(|rate|) to nearest step.
        euint256 step  = FHE.asEuint256(_FUND_STEP_X18);
        euint256 half  = FHE.asEuint256(_FUND_STEP_X18 / 2);
        euint256 absV  = fundingRatePerSecX18.val; // |rate|
        euint256 adj   = FHE.add(absV, half);
        euint256 q     = FHE.div(adj, step);
        euint256 magR  = FHE.mul(q, step);

        // Encode sign as 0/1 for decrypt
        euint256 sign01 = FHE.select(fundingRatePerSecX18.sign, FHE.asEuint256(1), FHE.asEuint256(0));

        _fundingMagRoundedEnc = magR;
        _fundingSign01Enc     = sign01;
        _fundingPending       = true;

        FHE.decrypt(_fundingMagRoundedEnc);
        FHE.decrypt(_fundingSign01Enc);

        FHE.allowThis(_fundingMagRoundedEnc);
        FHE.allowThis(_fundingSign01Enc);

        emit FundingRateRequested(nowTs);
    }

    /// @notice Step 2: finalize after decrypt is ready -> stores & emits the rounded value.
    function finalizeFundingRatePublish() public returns (int256 roundedX18) {
        require(_fundingPending, "FR: none");
        (uint256 magR, bool ok1) = FHE.getDecryptResultSafe(_fundingMagRoundedEnc);
        (uint256 s01,  bool ok2) = FHE.getDecryptResultSafe(_fundingSign01Enc);
        require(ok1 && ok2, "FR: not ready");

        int256 signed = s01 == 1 ? int256(magR) : -int256(magR);
        lastFundingRatePerSecRoundedX18 = signed;
        lastFundingPublishAt = block.timestamp;
        _fundingPending = false;

        // Re-allow slots for reuse
        FHE.allowThis(_fundingMagRoundedEnc);
        FHE.allowThis(_fundingSign01Enc);

        emit FundingRateUpdated(signed, block.timestamp);
        return signed;
    }

    // ========= Impact Grid (rounded bps public) =========
    uint256 public lastImpactPublishAt;

    uint32[] public lastGridSizesUsd;      // e.g. [1_000, 5_000, 10_000] (whole USD)
    int32[]  public lastGridLongImpactBps; // signed bps (+penalty / -rebate)
    int32[]  public lastGridShortImpactBps;

    // Pending buffers for decrypt
    bool     private _gridPending;
    uint32[] private _gridSizesStaged;
    uint256  private _gridOraclePriceE8;

    euint256[] private _gridLongBpsAbsEnc;
    euint256[] private _gridLongSign01Enc;
    euint256[] private _gridShortBpsAbsEnc;
    euint256[] private _gridShortSign01Enc;

    event ImpactGridRequested(uint32[] sizesUsd, uint256 oraclePriceE8, uint256 timestamp);
    event ImpactGridUpdated(uint32[] sizesUsd, int32[] longBps, int32[] shortBps, uint256 oraclePriceE8, uint256 timestamp);

    /// @notice Step 1: compute encrypted, **rounded bps** for each size and request decrypt (cadence-gated).
    function requestImpactGrid(uint32[] calldata sizesUsd) public {
        uint256 nowTs = block.timestamp;
        require(nowTs >= lastImpactPublishAt + IMPACT_PUBLISH_INTERVAL, "IG: cadence");
        require(!_gridPending, "IG: pending");
        require(sizesUsd.length > 0 && sizesUsd.length <= 16, "IG: len");

        // snapshot oracle price
        uint256 priceE8 = _markPrice();

        // stage arrays
        delete _gridSizesStaged;
        delete _gridLongBpsAbsEnc;
        delete _gridLongSign01Enc;
        delete _gridShortBpsAbsEnc;
        delete _gridShortSign01Enc;

        _gridSizesStaged = sizesUsd;
        _gridOraclePriceE8 = priceE8;

        _gridLongBpsAbsEnc  = new euint256[](sizesUsd.length);
        _gridLongSign01Enc  = new euint256[](sizesUsd.length);
        _gridShortBpsAbsEnc = new euint256[](sizesUsd.length);
        _gridShortSign01Enc = new euint256[](sizesUsd.length);

        for (uint256 i = 0; i < sizesUsd.length; ++i) {
            uint256 sizeUSDC6 = uint256(sizesUsd[i]) * 1e6;
            euint256 encSize  = FHE.asEuint256(sizeUSDC6);

            // Long open impact
            (euint256 gL, euint256 lL) = _encImpactEntryBucketsAtOpenX18(true,  encSize, priceE8);
            _gridLongBpsAbsEnc[i]  = _impactBucketsToRoundedBpsAbsEnc(lL, gL, encSize);
            _gridLongSign01Enc[i]  = _sign01FromBuckets(lL, gL);

            // Short open impact
            (euint256 gS, euint256 lS) = _encImpactEntryBucketsAtOpenX18(false, encSize, priceE8);
            _gridShortBpsAbsEnc[i] = _impactBucketsToRoundedBpsAbsEnc(lS, gS, encSize);
            _gridShortSign01Enc[i] = _sign01FromBuckets(lS, gS);

            // request decrypts & allow
            FHE.decrypt(_gridLongBpsAbsEnc[i]);  FHE.allowThis(_gridLongBpsAbsEnc[i]);
            FHE.decrypt(_gridLongSign01Enc[i]);  FHE.allowThis(_gridLongSign01Enc[i]);
            FHE.decrypt(_gridShortBpsAbsEnc[i]); FHE.allowThis(_gridShortBpsAbsEnc[i]);
            FHE.decrypt(_gridShortSign01Enc[i]); FHE.allowThis(_gridShortSign01Enc[i]);
        }

        _gridPending = true;
        emit ImpactGridRequested(sizesUsd, priceE8, nowTs);
    }

    /// @notice Step 2: finalize the impact grid after decrypt is ready -> stores & emits rounded bps.
    function finalizeImpactGrid() public {
        require(_gridPending, "IG: none");

        uint256 n = _gridSizesStaged.length;
        int32[] memory longBps  = new int32[](n);
        int32[] memory shortBps = new int32[](n);

        for (uint256 i = 0; i < n; ++i) {
            (uint256 magL, bool ok1) = FHE.getDecryptResultSafe(_gridLongBpsAbsEnc[i]);
            (uint256 sL,   bool ok2) = FHE.getDecryptResultSafe(_gridLongSign01Enc[i]);
            (uint256 magS, bool ok3) = FHE.getDecryptResultSafe(_gridShortBpsAbsEnc[i]);
            (uint256 sS,   bool ok4) = FHE.getDecryptResultSafe(_gridShortSign01Enc[i]);
            require(ok1 && ok2 && ok3 && ok4, "IG: not ready");

            int256 signedL = sL == 1 ? int256(magL) : -int256(magL);
            int256 signedS = sS == 1 ? int256(magS) : -int256(magS);

            // clamp to int32
            if (signedL > type(int32).max) signedL = type(int32).max;
            if (signedL < type(int32).min) signedL = type(int32).min;
            if (signedS > type(int32).max) signedS = type(int32).max;
            if (signedS < type(int32).min) signedS = type(int32).min;

            longBps[i]  = int32(signedL);
            shortBps[i] = int32(signedS);
        }

        lastGridSizesUsd = _gridSizesStaged;
        lastGridLongImpactBps = longBps;
        lastGridShortImpactBps = shortBps;
        lastImpactPublishAt = block.timestamp;

        _gridPending = false;
        emit ImpactGridUpdated(_gridSizesStaged, longBps, shortBps, _gridOraclePriceE8, block.timestamp);
    }

    // ========= Per-request encrypted impact (Option B) =========
    uint256 public constant IMPACT_REQUEST_COOLDOWN = 60; // seconds per user

    struct PendingImpact {
        euint256 bpsAbsEnc;
        euint256 sign01Enc;
        uint32   sizeUsd;
        bool     isLong;
        uint256  oraclePriceE8;
        uint256  requestedAt;
        bool     active;
    }
    mapping(address => PendingImpact) private _pendingImpact;

    event ImpactRequested(address indexed user, bool isLong, uint32 sizeUsd, uint256 oraclePriceE8, uint256 timestamp);
    event ImpactReady(address indexed user, bool isLong, uint32 sizeUsd, int32 impactBps, uint256 oraclePriceE8, uint256 timestamp);

    /// @notice Step 1: user (or keeper) requests a single-size impact estimate; result is encrypted until finalized.
    function requestImpactForSize(bool isLong, uint32 sizeUsd) external {
        PendingImpact storage P = _pendingImpact[msg.sender];
        require(!P.active || block.timestamp >= P.requestedAt + IMPACT_REQUEST_COOLDOWN, "IQ: cool");
        uint256 priceE8 = _markPrice();

        uint256 sizeUSDC6 = uint256(sizeUsd) * 1e6;
        euint256 encSize  = FHE.asEuint256(sizeUSDC6);

        (euint256 gainX18, euint256 lossX18) = _encImpactEntryBucketsAtOpenX18(isLong, encSize, priceE8);

        P.bpsAbsEnc     = _impactBucketsToRoundedBpsAbsEnc(lossX18, gainX18, encSize);
        P.sign01Enc     = _sign01FromBuckets(lossX18, gainX18);
        P.sizeUsd       = sizeUsd;
        P.isLong        = isLong;
        P.oraclePriceE8 = priceE8;
        P.requestedAt   = block.timestamp;
        P.active        = true;

        FHE.decrypt(P.bpsAbsEnc);  FHE.allowThis(P.bpsAbsEnc);
        FHE.decrypt(P.sign01Enc);  FHE.allowThis(P.sign01Enc);

        emit ImpactRequested(msg.sender, isLong, sizeUsd, priceE8, block.timestamp);
    }

    /// @notice Step 2: caller finalizes and receives the rounded, signed bps.
    function finalizeImpactForSize() external returns (int32 impactBps) {
        PendingImpact storage P = _pendingImpact[msg.sender];
        require(P.active, "IQ: none");

        (uint256 mag, bool ok1) = FHE.getDecryptResultSafe(P.bpsAbsEnc);
        (uint256 s01, bool ok2) = FHE.getDecryptResultSafe(P.sign01Enc);
        require(ok1 && ok2, "IQ: not ready");

        int256 signed = s01 == 1 ? int256(mag) : -int256(mag);
        if (signed > type(int32).max) signed = type(int32).max;
        if (signed < type(int32).min) signed = type(int32).min;

        impactBps = int32(signed);
        emit ImpactReady(msg.sender, P.isLong, P.sizeUsd, impactBps, P.oraclePriceE8, block.timestamp);

        P.active = false; // cooldown applies
    }

    // ========= Internal helpers =========

    /// @dev From impact buckets (loss, gain) & size, compute **rounded integer bps** as encrypted euint256.
    function _impactBucketsToRoundedBpsAbsEnc(
        euint256 lossX18,
        euint256 gainX18,
        euint256 encSize
    ) internal returns (euint256 bpsAbsEnc) {
        // net magnitude X18 (non-negative)
        ebool lossGE = FHE.gte(lossX18, gainX18);
        euint256 big   = FHE.select(lossGE, lossX18, gainX18);
        euint256 small = FHE.select(lossGE, gainX18, lossX18);
        euint256 netX18 = FHE.sub(big, small);

        // fraction per size: netX18 / size  (X18 fraction)
        euint256 fracX18 = FHE.div(netX18, encSize);

        // integer bps = round( fracX18 / 1bp )
        euint256 halfBp = FHE.asEuint256(_HALF_BP_X18);
        euint256 oneBp  = FHE.asEuint256(_ONE_BP_X18);
        euint256 adj    = FHE.add(fracX18, halfBp);
        euint256 q      = FHE.div(adj, oneBp); // integer bps
        return q;
    }

    /// @dev Encode sign as 0/1 from loss/gain buckets
    function _sign01FromBuckets(euint256 lossX18, euint256 gainX18) internal returns (euint256) {
        ebool lossGE = FHE.gte(lossX18, gainX18);
        return FHE.select(lossGE, FHE.asEuint256(1), FHE.asEuint256(0));
    }

    function ownerEquity(uint256 positionId) external {
        // only position owner may call
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "Not owner");
        require(p.status < Status.Liquidated, "closed position");

        p.pendingEquityX18 = _encEquityOnlyX18(p, _markPrice());

        // only owner may read offchain
        FHE.allowSender(p.pendingEquityX18);
        FHE.allowThis(p.pendingEquityX18);
    }
}
