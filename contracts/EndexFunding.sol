// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexFunding is EndexBase {
    using FHEHelpers for *;

    /// @notice Accrue cumulative funding using current fundingRatePerSecond.
    function _updateFunding() internal override {
        uint256 nowTs = block.timestamp;
        if (nowTs == lastFundingUpdate) return;

        uint256 dt = nowTs - lastFundingUpdate;
        lastFundingUpdate = nowTs;

        euint256 bump = FHE.mul(fundingRatePerSecond.val, FHE.asEuint256(dt));

        // long side accrues +rate; short side accrues -rate
        FHEHelpers.encAddSigned(cumFundingLong,  fundingRatePerSecond.sign,           bump);
        FHEHelpers.encAddSigned(cumFundingShort, FHE.not(fundingRatePerSecond.sign),  bump);

        FHEHelpers.allowThis(cumFundingLong);
        FHEHelpers.allowThis(cumFundingShort);
    }

    /// @dev Derive encrypted fundingRatePerSecond from encrypted skew and clamp |rate|.
    /// @dev Call this AFTER any change to long/short OI.
    function _setFundingRateFromSkew() internal override {
        // abs skew & sign (long-heavy => sign=true)
        ebool skewGE = FHE.gte(encLongOI, encShortOI);
        euint256 max = FHE.select(skewGE, encLongOI, encShortOI);
        euint256 min = FHE.select(skewGE, encShortOI, encLongOI);
        euint256 absSkew = FHE.sub(max, min); // 1e6
    
        // total OI (avoid div-by-zero)
        euint256 totalOI = FHE.add(encLongOI, encShortOI); // 1e6
        ebool isZero     = FHE.eq(totalOI, ZERO);
        euint256 denom   = FHE.select(isZero, ONE, totalOI);
    
        // fracX18 = (absSkew / totalOI) in X18
        euint256 numer   = FHE.mul(absSkew, ONE_X18);
        euint256 fracX18 = FHE.div(numer, denom); // 0..1e18 range
    
        // rate = frac * MAX_RATE  (both X18/sec)  => divide by 1e18 to keep X18
        euint256 maxRate = FHE.asEuint256(MAX_ABS_FUNDING_RATE_PER_SEC_X18); // X18/sec
        euint256 prod    = FHE.mul(fracX18, maxRate);          // X36
        euint256 rateMag = FHE.div(prod, ONE_X18); // X18/sec
    
        fundingRatePerSecond = eint256({ sign: skewGE, val: rateMag });

        FHEHelpers.allowThis(fundingRatePerSecond);
    }
}
