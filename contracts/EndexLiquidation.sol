// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexLiquidation is EndexBase {
    using FHEHelpers for *;

    // ===============================
    // LIQUIDATION
    // ===============================
    function requestLiqChecks(uint256[] calldata positionIds) external {
        // Keep funding fresh for equity calc
        _pokeFunding();
        uint256 price = _markPrice();

        for (uint256 i = 0; i < positionIds.length; i++) {
            IEndex.Position storage p = positions[positionIds[i]];
            if (p.status != IEndex.Status.Open) continue;

            // required = size * MAINT_MARGIN_BPS * 1e14 (BPS -> X18)
            console.log("calc encReqX18..");
            euint256 encReqX18 = FHE.mul(p.size, FHE.asEuint256(MAINT_MARGIN_BPS * 1e14));

            console.log("get enc equity operands..");
            (euint256 lhs, euint256 rhs) = _encEquityOperandsForLiqX18(p, price, encReqX18);

            // needLiq = (lhs < rhs)
            console.log("get needLiq..");
            ebool needLiq = FHE.lt(lhs, rhs);

            // 0/1 encrypted flag and request decrypt
            console.log("calc pending liq flag..");
            p.pendingLiqFlagEnc = FHE.select(needLiq, FHEHelpers._one(), FHEHelpers._zero());
            p.pendingLiqCheckPrice = price;
            p.liqCheckPending = true;
            FHE.decrypt(p.pendingLiqFlagEnc);

            FHE.allowThis(p.pendingLiqFlagEnc);
            FHE.allowThis(p.size);
        }
    }

    function finalizeLiqChecks(uint256[] calldata positionIds) external {
            console.log("in finalize liq checks..");
        for (uint256 i = 0; i < positionIds.length; i++) {
            IEndex.Position storage p = positions[positionIds[i]];
            console.log("checking pos id..");
            if (!p.liqCheckPending || p.status != IEndex.Status.Open) continue;
            
            console.log("getting pending flag..");
            (uint256 flag, bool ready) = FHE.getDecryptResultSafe(p.pendingLiqFlagEnc);
            if (!ready) continue;

            p.liqCheckPending = false;

            console.log("check flag..");
            if (flag == 1) {
                console.log("set up settlement..");
                p.cause = IEndex.CloseCause.Liquidation;
                _setupSettlement(p, p.pendingLiqCheckPrice);
            }

            FHE.allowThis(p.pendingLiqFlagEnc);
        }
    }

    /// @dev Build LHS/RHS (X18) for encrypted liquidation compare without negative ciphertexts.
    /// Uses only entry impact (exit impact is not included during liquidation checks).
    function _encEquityOperandsForLiqX18(
        IEndex.Position storage p,
        uint256 price,
        euint256 encRequiredX18
    ) internal returns (euint256 lhsX18, euint256 rhsX18) {

        console.log("calc pnl..");
        (euint256 priceGainX18, euint256 priceLossX18) = _encPnlBucketsX18(p, price);
        console.log("calc funding..");
        (euint256 fundGainX18,  euint256 fundLossX18)  = _encFundingBucketsX18(p);

        // Aggregate (encrypted, non-negative) + include entry price impact
        console.log("add gains..");
        euint256 gainsX18  = FHE.add(priceGainX18, fundGainX18);
        gainsX18           = FHE.add(gainsX18,  p.encImpactEntryGainX18);

        console.log("add losses..");
        euint256 lossesX18 = FHE.add(priceLossX18, fundLossX18);
        lossesX18          = FHE.add(lossesX18, p.encImpactEntryLossX18);

        // Operands
        console.log("collateral mul..");
        euint256 collX18 = FHE.asEuint256(p.collateral * ONE_X18);
        console.log("lhs/rhs calc..");
        lhsX18 = FHE.add(collX18, gainsX18);
        rhsX18 = FHE.add(lossesX18, encRequiredX18);
    }
}
