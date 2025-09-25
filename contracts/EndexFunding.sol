// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexFunding is EndexBase {
    using FHEHelpers for *;
    // ===============================
    // FUNDING
    // ===============================
    /// @notice Accrue cumulative funding using current fundingRatePerSecX18.
    function _pokeFunding() internal override {
        uint256 nowTs = block.timestamp;
        if (nowTs == lastFundingUpdate) return;

        uint256 dt = nowTs - lastFundingUpdate;
        lastFundingUpdate = nowTs;

        euint256 bump = FHE.mul(fundingRatePerSecX18.val, FHE.asEuint256(dt));

        // long side accrues +rate; short side accrues -rate
        FHEHelpers._encAddSigned(cumFundingLongX18,  fundingRatePerSecX18.sign,          bump);
        FHEHelpers._encAddSigned(cumFundingShortX18, FHEHelpers._ebNot(fundingRatePerSecX18.sign),  bump);

        _allowFunding();
    }

    /// @dev Derive encrypted fundingRatePerSecX18 from encrypted skew and clamp |rate|.
    /// @dev Call this AFTER any change to long/short OI.
    function _setFundingRateFromSkew() internal override {
        // abs skew and sign
        ebool skewGE = FHE.gte(encLongOI, encShortOI);
        euint256 encMax = FHE.select(skewGE, encLongOI, encShortOI);
        euint256 encMin = FHE.select(skewGE, encShortOI, encLongOI);
        euint256 absSkew = FHE.sub(encMax, encMin);

        // scale skew to rate magnitude; use 1e6 factor so units match
        euint256 rateMag = FHE.mul(absSkew, FHE.asEuint256(1e6));

        // clamp
        euint256 rateEnc = FHE.asEuint256(MAX_ABS_FUNDING_RATE_PER_SEC_X18);
        ebool over = FHE.gte(rateMag, rateEnc);
        euint256 magClamped = FHE.select(over, rateEnc, rateMag);

        fundingRatePerSecX18 = eint256({ sign: skewGE, val: magClamped });
        _allowFunding();
    }

    // allow all encrypted funding vars
    function _allowFunding() internal {
        FHEHelpers._allowEint256(fundingRatePerSecX18);
        FHEHelpers._allowEint256(cumFundingLongX18);
        FHEHelpers._allowEint256(cumFundingShortX18);
    }
}
