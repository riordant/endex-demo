// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexImpact is EndexBase { 
    using FHEHelpers for *;

    /// @dev Entry impact buckets at open (before OI update).
    function _encImpactEntryBucketsAtOpenX18(
        ebool isLong,
        euint256 encSize,
        uint256 oraclePrice
    ) internal override returns (euint256 gainX18, euint256 lossX18) {
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
    ) internal override returns (euint256 gainX18, euint256 lossX18) {
        euint256 K = _impactKEnc(oraclePrice);

        (euint256 encAbsSkew, ebool skewGEZero) = _encAbsSkewAndFlag();

        // Exit trade direction is opposite of position side
        //bool exitIsLong = !p.isLong;
        ebool exitIsLong = FHE.eq(p.isLong, FHE.asEbool(false));

        (euint256 deltaPos, euint256 deltaNeg) =
            _encDeltaPartsForImpact(exitIsLong, skewGEZero, p.size, encAbsSkew);

        lossX18 = FHE.mul(deltaPos, K);
        gainX18 = FHE.mul(deltaNeg, K);
    }

    /// @dev Encrypted K: K = (P0 * GAMMA_X18) / (2 * L * IMPACT_SCALER)
    function _impactKEnc(uint256 oraclePrice) internal returns (euint256 K) {
        // numerator is plaintext -> encrypt once
        uint256 numPlain = oraclePrice * IMPACT_GAMMA_X18; // 8d * 1e18 ~ 1e26
        euint256 num = FHE.asEuint256(numPlain);

        euint256 L = _impactLiquidityScaleUSD_enc();
        euint256 den1 = FHE.mul(L, FHEHelpers._two());
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
        ebool isLong,
        ebool skewGEZero,
        euint256 encSize,
        euint256 encAbsSkew
    ) internal returns (euint256 deltaPos, euint256 deltaNeg) {
        // Common terms: size^2 and 2*|skew|*size
        euint256 size2    = FHE.mul(encSize, encSize);
        euint256 twoAbs   = FHE.mul(encAbsSkew, FHE.asEuint256(2));
        euint256 twoSsize = FHE.mul(twoAbs, encSize);

        // Magnitude of (size^2 - 2|s|size)
        ebool size2Ge = FHE.gte(size2, twoSsize);
        euint256 diff = FHE.sub(
            FHE.select(size2Ge, size2,    twoSsize),
            FHE.select(size2Ge, twoSsize, size2)
        );

        // Always non-negative part of (s±)^2 difference
        euint256 alwaysPos = FHE.add(size2, twoSsize);

        (deltaPos, deltaNeg) = _getDelta(isLong, skewGEZero, size2Ge, diff, alwaysPos);
    }

    function _getDelta(
        ebool isLong, 
        ebool skewGEZero, 
        ebool size2Ge,
        euint256 diff, 
        euint256 a
    ) private returns(euint256 deltaPos, euint256 deltaNeg) {
        euint256 b = FHE.select(size2Ge, diff, FHEHelpers._zero());
        euint256 c = FHE.select(size2Ge, FHEHelpers._zero(), diff);
        euint256 O = FHEHelpers._zero();

        // Route to positive/negative buckets based on side & skew sign
        // long  (isLong ==  true): 
        //     - skew>=0 (skewGEZero == true) => alwaysPos (a); 
        //     - skew<0 (skewGEZero == false) => +/- diff
        // short (isLong == false): 
        //     - skew<0 (skewGEZero == false) => alwaysPos (a); 
        //     - skew>=0 (skewGEZero == true) => +/- diff
        deltaPos = FHE.select(skewGEZero, 
            FHE.select(isLong, a, b), 
            FHE.select(isLong, b, a)
        );

        deltaNeg = FHE.select(skewGEZero, 
            FHE.select(isLong, O, c), 
            FHE.select(isLong, c, O)
        );
    }

    /// @dev Compute L_eff (USD, 6d) from TVL and a public utilization proxy (|rate|).
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
}
