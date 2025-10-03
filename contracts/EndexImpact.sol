// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./EndexBase.sol";

abstract contract EndexImpact is EndexBase { 
    using FHEHelpers for *;

    // ===== Price Impact Params (ETH-only tuning) =====
    uint256 public constant IMPACT_GAMMA_X18       = 3e15;      // 0.003 (dimensionless)
    uint256 public constant IMPACT_TVL_FACTOR_BPS  = 5000;      // 50% of pool balance
    uint256 public constant IMPACT_MIN_LIQ_USD     = 100_000e6; // 100k underlying floor (6d)
    uint256 public constant IMPACT_UTIL_BETA_X18   = 1e18;      // strengthen impact under high |rate|
    uint256 public constant IMPACT_SCALER          = 1e14;      // units helper

    /// @dev Entry impact bucket at open (before OI update).
    function _impactEntryBucketAtOpen(
        ebool isLong,
        euint256 size,
        uint256 oraclePrice
    ) internal override returns (eint256 memory entryImpact) {
        euint256 K = _impactK(oraclePrice);

        eint256 memory skew = _skew();

        (euint256 deltaPos, euint256 deltaNeg) =
            _encDeltaPartsForImpact(isLong, size, skew);

        // impactX18 = delta * K; positive => trader loss, negative => trader gain
        eint256 memory lossX18 = eint256({sign: FALSE, val: FHE.mul(deltaPos, K)});
        eint256 memory gainX18 = eint256({sign: TRUE, val: FHE.mul(deltaNeg, K)});

        entryImpact = FHEHelpers.encAddSigned(lossX18, gainX18);
    }

    /// @dev Exit impact bucket at close (before OI is removed).
    /// For exit, the trade is in the OPPOSITE direction with size = position.size.
    function _impactExitBucketAtClose(
        Position storage p,
        uint256 oraclePrice
    ) internal override returns (eint256 memory exitImpact) {
        euint256 K = _impactK(oraclePrice);

        eint256 memory skew = _skew();

        // Exit trade direction is opposite of position side
        ebool exitIsLong = FHE.not(p.isLong);

        (euint256 deltaPos, euint256 deltaNeg) =
            _encDeltaPartsForImpact(exitIsLong, p.size, skew);

        eint256 memory lossX18 = eint256({sign: FALSE, val: FHE.mul(deltaPos, K)});
        eint256 memory gainX18 = eint256({sign: TRUE, val: FHE.mul(deltaNeg, K)});

        exitImpact = FHEHelpers.encAddSigned(lossX18, gainX18);
    }

    /// @dev Encrypted K: K = (P0 * GAMMA_X18) / (2 * L * IMPACT_SCALER)
    function _impactK(uint256 oraclePrice) internal returns (euint256 K) {
        // numerator is plaintext -> encrypt once
        uint256 numPlain = oraclePrice * IMPACT_GAMMA_X18; // 8d * 1e18 ~ 1e26
        euint256 num = FHE.asEuint256(numPlain);

        euint256 L = _impactLiquidityScaleUSD_enc();
        euint256 den1 = FHE.mul(L, TWO);
        euint256 den = FHE.mul(den1, FHE.asEuint256(IMPACT_SCALER));

        K = FHE.div(num, den); // if num<den, K→0 automatically
    }

    /// @dev Return |skew| (encrypted) and encrypted boolean "skew >= 0".
    function _skew() internal returns (eint256 memory skew) {
        skew.sign = FHE.gte(encLongOI, encShortOI);
        euint256 encMax = FHE.select(skew.sign, encLongOI, encShortOI);
        euint256 encMin = FHE.select(skew.sign, encShortOI, encLongOI);
        skew.val = FHE.sub(encMax, encMin);
    }

    /// @dev Build delta parts for entry/exit impact using non-negative buckets.
    /// deltaPos => contributes to trader loss; deltaNeg => contributes to trader gain.
    function _encDeltaPartsForImpact(
        ebool isLong,
        euint256 size,
        eint256 memory skew
    ) internal returns (euint256 deltaPos, euint256 deltaNeg) {
        // Common terms: size^2 and 2*|skew|*size
        euint256 size2    = FHE.mul(size, size);
        euint256 twoAbs   = FHE.mul(skew.val, TWO);
        euint256 twoSsize = FHE.mul(twoAbs, size);

        // Magnitude of (size^2 - 2|s|size)
        ebool size2Ge = FHE.gte(size2, twoSsize);
        euint256 diff = FHE.sub(
            FHE.select(size2Ge, size2,    twoSsize),
            FHE.select(size2Ge, twoSsize, size2)
        );

        // Always non-negative part of (s±)^2 difference
        euint256 alwaysPos = FHE.add(size2, twoSsize);

        (deltaPos, deltaNeg) = _getDelta(isLong, skew.sign, size2Ge, diff, alwaysPos);
    }

    function _getDelta(
        ebool isLong, 
        ebool skewGEZero, 
        ebool size2Ge,
        euint256 diff, 
        euint256 a
    ) private returns(euint256 deltaPos, euint256 deltaNeg) {
        euint256 b = FHE.select(size2Ge, diff, ZERO);
        euint256 c = FHE.select(size2Ge, ZERO, diff);

        // Route to positive/negative buckets based on side & skew sign
        deltaPos = FHE.select(skewGEZero, 
            FHE.select(isLong, a, b), 
            FHE.select(isLong, b, a)
        );

        deltaNeg = FHE.select(skewGEZero, 
            FHE.select(isLong, ZERO, c), 
            FHE.select(isLong, c, ZERO)
        );
    }

    /// @dev Compute L_eff (USD, 6d) from TVL and a public utilization proxy (|rate|).
    function _impactLiquidityScaleUSD_enc() internal returns (euint256 L) {
        // base = max(totalLiquidity * FACTOR_BPS / 1e4, MIN_LIQ)
        uint256 basePlain = (totalLiquidity * IMPACT_TVL_FACTOR_BPS) / BPS_DIVISOR;
        if (basePlain < IMPACT_MIN_LIQ_USD) basePlain = IMPACT_MIN_LIQ_USD;
        euint256 base = FHE.asEuint256(basePlain);

        // absRate = |fundingRatePerSecond|
        euint256 absRate = fundingRatePerSecond.val;

        // norm in [0, 1e18] = min(1e18, absRate * 1e18 / MAX_ABS)
        euint256 num   = FHE.mul(absRate, ONE_X18);
        euint256 norm  = FHE.div(num, FHE.asEuint256(MAX_ABS_FUNDING_RATE_PER_SEC_X18));
        ebool cap      = FHE.gte(norm, ONE_X18);
        euint256 normC = FHE.select(cap, ONE_X18, norm);

        // scaleX18 = 1e18 + beta * normC / 1e18
        euint256 betaNorm = FHE.mul(FHE.asEuint256(IMPACT_UTIL_BETA_X18), normC);
        euint256 betaTerm = FHE.div(betaNorm, ONE_X18);
        euint256 scaleX18 = FHE.add(ONE_X18, betaTerm);

        // L = base * 1e18 / scaleX18
        euint256 numL = FHE.mul(base, ONE_X18);
        L = FHE.div(numL, scaleX18);
    }
}
