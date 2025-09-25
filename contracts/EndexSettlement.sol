// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexSettlement is EndexBase {
    using SafeERC20 for IERC20;

    event PositionClosed(
        uint256 indexed positionId,
        address indexed owner,
        int256 pnl,          // kept for compatibility; 0 when using encrypted equity path
        uint256 payout,      // net payout to user (after fee)
        IEndex.Status status,       // Closed or Liquidated
        uint256 closePrice,  // settlementPrice used
        uint256 feePaid
    );

    // ===============================
    // SETTLEMENT
    // ===============================
    function _setupSettlement(IEndex.Position storage p, uint256 settlementPrice) internal override {
        // Accrue funding to now
        _pokeFunding();

        // Build encrypted equity at this price (X18) including exit impact, then request decrypt
        euint256 encEqX18 = _encEquityOnlyX18(p, settlementPrice);
        p.pendingEquityX18 = encEqX18;
        FHE.decrypt(p.pendingEquityX18);

        p.status = IEndex.Status.AwaitingSettlement;
        p.settlementPrice = settlementPrice;

        FHE.allowThis(p.pendingEquityX18);
        FHE.allowGlobal(p.pendingEquityX18);
    }

    function _settle(uint256 positionId) internal override {
        IEndex.Position storage p = positions[positionId];
        require(p.status == IEndex.Status.AwaitingSettlement, "not awaiting settlement");

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
        } else {
            encShortOI = FHE.sub(encShortOI, p.size);
        }

        // After OI change, update funding rate for future accruals
        _setFundingRateFromSkew();

        // Mark final status by cause
        p.status = (p.cause == IEndex.CloseCause.Liquidation) ? IEndex.Status.Liquidated : IEndex.Status.Closed;

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

    /// @dev Encrypted equity (X18), clamped to zero. Includes **exit impact** at settlement.
    /// equityX18 = max(0, collateral*1e18 + gainsX18 - lossesX18)
    function _encEquityOnlyX18(
        IEndex.Position storage p,
        uint256 price
    ) internal returns (euint256) {
        (euint256 pnlGainX18, euint256 pnlLossX18) = _encPnlBucketsX18(p, price);
        (euint256 fundGainX18,  euint256 fundLossX18)  = _encFundingBucketsX18(p);

        // exit impact at settlement
        (euint256 exitGainX18, euint256 exitLossX18) = _encImpactExitBucketsAtCloseX18(p, price);

        // include entry + exit price impact
        euint256 gainsX18  = FHE.add(pnlGainX18, fundGainX18);
        gainsX18           = FHE.add(gainsX18,  p.encImpactEntryGainX18);
        gainsX18           = FHE.add(gainsX18,  exitGainX18);

        euint256 lossesX18 = FHE.add(pnlLossX18, fundLossX18);
        lossesX18          = FHE.add(lossesX18, p.encImpactEntryLossX18);
        lossesX18          = FHE.add(lossesX18, exitLossX18);

        euint256 collX18   = FHE.asEuint256(p.collateral * ONE_X18);
        euint256 lhs       = FHE.add(collX18, gainsX18);

        // equity = max(0, lhs - losses)
        ebool insolvent    = FHE.lt(lhs, lossesX18);
        euint256 diff      = FHE.sub(FHE.select(insolvent, lossesX18, lhs),
                                     FHE.select(insolvent, lhs,       lossesX18));
        // if insolvent => 0; else => diff
        return FHE.select(insolvent, FHEHelpers._zero(), diff);
    }

    /// @dev Price PnL buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _encPnlBucketsX18(
        IEndex.Position storage p,
        uint256 price
    ) internal override returns (euint256 gainX18, euint256 lossX18) {
        // ratioX18 = 1e18 * P / E  (plaintext for sign; encrypted magnitude below)
        uint256 ratioX18 = (price * ONE_X18) / p.entryPrice;
        uint256 deltaX18 = ratioX18 >= ONE_X18 ? (ratioX18 - ONE_X18) : (ONE_X18 - ratioX18);

        // Encrypted magnitude = size * |ratio - 1|
        euint256 encMagX18 = FHE.mul(p.size, FHE.asEuint256(deltaX18));

        // Price move sign (plaintext, uses public prices + side)
        bool priceGain = p.isLong ? (price >= p.entryPrice) : (price <= p.entryPrice);
        if (priceGain) {
            gainX18 = encMagX18;
            lossX18 = FHEHelpers._zero();
        } else {
            gainX18 = FHEHelpers._zero();
            lossX18 = encMagX18;
        }
    }

    /// @dev Funding buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _encFundingBucketsX18(
        IEndex.Position storage p
    ) internal override returns (euint256 gainX18, euint256 lossX18) {
        // dF = currentCum - entryFunding (encrypted signed)
        eint256 memory cur = p.isLong ? cumFundingLongX18 : cumFundingShortX18;
        eint256 memory dF  = FHEHelpers._encSubSigned(cur, p.entryFundingX18);

        // magnitude
        euint256 magX18 = FHE.mul(p.size, dF.val);

        // For long: dF >= 0 => loss; For short: same rule holds because we snapshot side-specific index.
        // Put magnitude to loss if dF.sign==true (>=0), else to gain.
        ebool lossFlag = dF.sign;
        lossX18 = FHE.select(lossFlag, magX18, FHEHelpers._zero());
        gainX18 = FHE.select(lossFlag, FHEHelpers._zero(), magX18);
    }
}
