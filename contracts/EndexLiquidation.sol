// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexLiquidation is EndexBase {
    using FHEHelpers for *;

    function _liquidationCheck(uint256 positionId, uint256 price) internal override {
        Position storage p = positions[positionId];
        Validity storage v = p.validity;

        // required = size * MAINT_MARGIN_BPS * 1e14 (BPS -> X18)
        euint256 encReqX18 = FHE.mul(p.size, FHE.asEuint256(MAINT_MARGIN_BPS * 1e14));

        (euint256 lhs, euint256 rhs) = _encEquityOperandsForLiqX18(p, price, encReqX18);

        // needLiq = (lhs < rhs)

        // 0/1 encrypted flag and request decrypt
        v.toBeLiquidated = FHE.lt(lhs, rhs);
        p.pendingLiquidationPrice = price;

        // decrypt and make toBeLiquidated available to all users
        FHE.allowGlobal(v.toBeLiquidated);
        FHE.decrypt(v.toBeLiquidated);
        FHE.allowThis(p.size);
    }

    function _liquidationFinalize(uint256 positionId) internal override {
        Position storage p = positions[positionId];
        p.cause = CloseCause.Liquidation;
        _setupSettlement(positionId, p.pendingLiquidationPrice);
    }

    /// @dev Build LHS/RHS (X18) for encrypted liquidation compare without negative ciphertexts.
    /// Uses only entry impact (exit impact is not included during liquidation checks).
    function _encEquityOperandsForLiqX18(
        Position storage p,
        uint256 price,
        euint256 encRequiredX18
    ) internal returns (euint256 lhsX18, euint256 rhsX18) {

        (euint256 priceGainX18, euint256 priceLossX18) = _encPnlBucketsX18(p, price);
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
}
