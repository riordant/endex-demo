// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexLiquidation is EndexBase {
    using FHEHelpers for *;

    function _liquidationCheck(uint256 positionId, uint256 price) internal override {
        Position storage p = positions[positionId];
        Validity storage v = p.validity;

        // required = size * MAINT_MARGIN_BPS (BPS -> X18)
        euint256 requiredMargin = FHE.mul(p.size, MAINT_MARGIN_BPS);

        // check if position equity is lower than margin requirements
        v.toBeLiquidated = _toBeLiquidated(p, price, requiredMargin);

        // price to be used if position is to be liquidated
        p.pendingLiquidationPrice = price;

        // decrypt and make toBeLiquidated available to all users
        FHE.allowGlobal(v.toBeLiquidated);
        FHE.decrypt(v.toBeLiquidated);
    }

    function _liquidationFinalize(uint256 positionId) internal override {
        Position storage p = positions[positionId];
        p.cause = CloseCause.Liquidation;
        _settlementInitialize(positionId, p.pendingLiquidationPrice);
    }

    /// @dev Build equiity (X18) for encrypted liquidation.
    /// Uses only entry impact (exit impact is not included during liquidation checks).
    function _toBeLiquidated(
        Position storage p,
        uint256 price,
        euint256 requiredMargin
    ) internal returns (ebool toBeLiquidated) {
        euint256 collX18   = FHE.asEuint256(p.collateral * 1e18);
        eint256 memory collateral = eint256({sign: TRUE, val: collX18});

        eint256 memory pnl = _pnlBucket(p, price);
        eint256 memory funding  = _fundingBucket(p);
        eint256 memory entryImpact  = p.entryImpact;

        eint256 memory pnlAndFunding = FHEHelpers.encAddSigned(pnl, funding);
        eint256 memory total         = FHEHelpers.encAddSigned(pnlAndFunding, entryImpact);
        eint256 memory equity        = FHEHelpers.encAddSigned(total, collateral);

        // if equity sign is false (ie. negative = second condition here) => liquidate.
        // else, if equity value is less than required margin => liquidate.
        toBeLiquidated = FHE.select(equity.sign, 
            FHE.lt(equity.val, requiredMargin),
            TRUE
        );
    }
}
