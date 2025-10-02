// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexSettlement is EndexBase {
    using SafeERC20 for IERC20;

    function _setupSettlement(uint256 positionId, uint256 settlementPrice) internal override {
        Position storage p = positions[positionId];
        // Accrue funding to now
        _pokeFunding();

        // Build encrypted equity at this price (X18), then request decrypt
        p.pendingEquityX18 = _encEquityOnlyX18(p, settlementPrice);
        FHE.decrypt(p.pendingEquityX18);

        p.status = Status.AwaitingSettlement;
        p.settlementPrice = settlementPrice;

        FHE.allowThis(p.pendingEquityX18);
        FHE.allowGlobal(p.pendingEquityX18);

        // set user equity on close
        _ownerEquity(positionId, settlementPrice);
    }

    function _settle(uint256 positionId) internal override returns(bool /* settled */) {
        Position storage p = positions[positionId];
        require(p.status == Status.AwaitingSettlement, "not awaiting settlement");

        (uint256 eqX18, bool ready) = FHE.getDecryptResultSafe(p.pendingEquityX18);
        if(!ready) return false; // equity not ready

        // Gross payout in USDC (6d)
        uint256 payoutGross = eqX18 / ONE_X18;

        // Close fee on payout
        uint256 fee = (payoutGross * CLOSE_FEE_BPS) / BPS_DIVISOR;
        uint256 payoutNet = payoutGross > fee ? (payoutGross - fee) : 0;

        // Transfer
        if (payoutNet > 0) {
            require(payoutNet <= totalLiquidity, "pool insolvent");
            totalLiquidity -= payoutNet;
            usdc.safeTransfer(p.owner, payoutNet);
        }

        totalCollateral -= p.collateral;

        // Update encrypted OI aggregates (remove size)
        // both values updated for privacy
        // (isLong) ? encLongOI -= size : encShortOI -= size
        encLongOI = FHE.sub(encLongOI, FHE.select(p.isLong, p.size, FHEHelpers._zero()));
        encShortOI = FHE.sub(encShortOI, FHE.select(p.isLong, FHEHelpers._zero(), p.size));

        // After OI change, update funding rate for future accruals
        _setFundingRateFromSkew();

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);

        return true;
    }

    /// @dev Encrypted equity (X18), clamped to zero.
    /// equityX18 = max(0, collateral*1e18 + gainsX18 - lossesX18)
    function _encEquityOnlyX18(
        Position storage p,
        uint256 price
    ) internal returns (euint256 equityNet) {
        euint256 collX18   = FHE.asEuint256(p.collateral * ONE_X18);
        eint256 memory collateral = eint256({sign: FHE.asEbool(true), val: collX18});

        eint256 memory pnl = _pnlBuckets(p, price);
        eint256 memory funding = _fundingBuckets(p);
        eint256 memory entryImpact = p.entryImpact;
        eint256 memory exitImpact = _impactExitBucketsAtClose(p, price);

        eint256 memory pnlAndFunding = FHEHelpers._encAddSigned(pnl, funding);
        eint256 memory totalImpact   = FHEHelpers._encAddSigned(entryImpact, exitImpact);
        eint256 memory total         = FHEHelpers._encAddSigned(pnlAndFunding, totalImpact);
        eint256 memory equity        = FHEHelpers._encAddSigned(total, collateral);

        // if insolvent => 0; else => diff
        equityNet = FHE.select(equity.sign, equity.val, FHE.asEuint256(0));

        //(euint256 pnlGainX18, euint256 pnlLossX18) = _pnlBuckets(p, price);
        //(euint256 fundGainX18,  euint256 fundLossX18)  = _fundingBuckets(p);

        // exit impact at settlement
        //(euint256 exitGainX18, euint256 exitLossX18) = _impactExitBucketsAtClose(p, price);
        //eint256 memory exitImpact = _impactExitBucketsAtClose(p, price);

        //// include entry impact
        //euint256 gainsX18  = FHE.add(pnlGainX18, fundGainX18);
        //gainsX18           = FHE.add(gainsX18,  p.encImpactEntryGainX18);
        //gainsX18           = FHE.add(gainsX18,  exitGainX18);

        //euint256 lossesX18 = FHE.add(pnlLossX18, fundLossX18);
        //lossesX18          = FHE.add(lossesX18, p.encImpactEntryLossX18);
        //lossesX18          = FHE.add(lossesX18, exitLossX18);

        //euint256 collX18   = FHE.asEuint256(p.collateral * ONE_X18);
        //euint256 lhs       = FHE.add(collX18, gainsX18);

        //// equity = max(0, lhs - losses)
        //ebool insolvent    = FHE.lt(lhs, lossesX18);
        //euint256 diff      = FHE.sub(FHE.select(insolvent, lossesX18, lhs),
        //                             FHE.select(insolvent, lhs,       lossesX18));
        //// if insolvent => 0; else => diff
        //return FHE.select(insolvent, FHEHelpers._zero(), diff);
    }

    /// @dev Price PnL buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _pnlBuckets(
        Position storage p,
        uint256 price
    ) internal override returns (eint256 memory pnl) {
        // ratioX18 = 1e18 * P / E  (plaintext for sign; encrypted magnitude below)
        uint256 ratioX18 = (price * ONE_X18) / p.entryPrice;
        uint256 deltaX18 = ratioX18 >= ONE_X18 ? (ratioX18 - ONE_X18) : (ONE_X18 - ratioX18);

        // Encrypted magnitude = size * |ratio - 1|
        euint256 encMagX18 = FHE.mul(p.size, FHE.asEuint256(deltaX18));

        // Price move sign (plaintext, uses public prices + side)
        ebool priceGE = FHE.asEbool(price >= p.entryPrice);
        ebool priceLT = FHE.asEbool(price < p.entryPrice);
        ebool priceGain = FHE.select(p.isLong, priceGE, priceLT);

        //gainX18 = FHE.select(priceGain, encMagX18, FHEHelpers._zero());
        //lossX18 = FHE.select(priceGain, FHEHelpers._zero(), encMagX18);
        pnl = eint256({ sign: priceGain, val: encMagX18 });
    }

    /// @dev Funding buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _fundingBuckets(
        Position storage p
    ) internal override returns (eint256 memory funding) {
        // dF = currentCum - entryFunding (encrypted signed)
        eint256 memory cur = FHEHelpers._selectEint(p.isLong, cumFundingLongX18, cumFundingShortX18);
        eint256 memory dF  = FHEHelpers._encSubSigned(cur, p.entryFunding);

        // magnitude
        euint256 magX18 = FHE.mul(p.size, dF.val);

        // For long: dF >= 0 => loss; For short: same rule holds because we snapshot side-specific index.
        // Put magnitude to loss if dF.sign==true (>=0), else to gain.
        ebool lossFlag = dF.sign;
        //lossX18 = FHE.select(lossFlag, magX18, FHEHelpers._zero());
        //gainX18 = FHE.select(lossFlag, FHEHelpers._zero(), magX18);

        ebool sign = FHE.select(lossFlag, FHE.asEbool(false), FHE.asEbool(true));
        funding = eint256({sign: sign, val: magX18});
    }
}
