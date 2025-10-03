// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./EndexBase.sol";

abstract contract EndexSettlement is EndexBase {
    using SafeERC20 for IERC20;

    function _settlementInitialize(uint256 positionId, uint256 settlementPrice) internal override {
        Position storage p = positions[positionId];

        // Accrue funding to now
        _updateFunding();

        // Build encrypted equity at this price (X18), then request decrypt
        p.pendingEquity = _calcNetEquity(p, settlementPrice);
        FHE.decrypt(p.pendingEquity);
        FHE.allowThis(p.pendingEquity);
        FHE.allowGlobal(p.pendingEquity);

        p.status = Status.AwaitingSettlement;
        p.settlementPrice = settlementPrice;

        // set user equity on close (to permit ongoing reads)
        _ownerEquity(positionId, settlementPrice);
    }

    function _settlementFinalize(uint256 positionId) internal override returns(bool /* settled */) {
        Position storage p = positions[positionId];
        require(p.status == Status.AwaitingSettlement, "not awaiting settlement");

        (uint256 equityX18, bool ready) = FHE.getDecryptResultSafe(p.pendingEquity);
        if(!ready) return false; // equity not ready

        // Gross payout in underlying (6d)
        uint256 equity = equityX18 / 1e18;

        // Close fee on payout
        uint256 fee = (equity * CLOSE_FEE_BPS) / BPS_DIVISOR;
        uint256 payout = equity > fee ? (equity - fee) : 0;

        // Transfer
        if (payout > 0) {
            require(payout <= totalLiquidity, "pool insolvent");
            totalLiquidity -= payout;
            underlying.safeTransfer(p.owner, payout);
        }
        
        // reduce collateral
        totalCollateral -= p.collateral;

        // Update encrypted OI aggregates (remove size)
        // both values updated for privacy
        // (isLong) ? encLongOI -= size : encShortOI -= size
        encLongOI  = FHE.sub( encLongOI, FHE.select(p.isLong, p.size, ZERO));
        encShortOI = FHE.sub(encShortOI, FHE.select(p.isLong, ZERO, p.size));

        // After OI change, update funding rate for future accruals
        _setFundingRateFromSkew();

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);

        return true;
    }

    /// @dev Encrypted equity (X18), clamped to zero.
    function _calcNetEquity(
        Position storage p,
        uint256 price
    ) internal returns (euint256 equityNet) {
        euint256 collX18   = FHE.asEuint256(p.collateral * 1e18);
        eint256 memory collateral = eint256({sign: TRUE, val: collX18});

        eint256 memory pnl = _pnlBucket(p, price);
        eint256 memory funding = _fundingBucket(p);
        eint256 memory entryImpact = p.entryImpact;
        eint256 memory exitImpact = _impactExitBucketAtClose(p, price);

        eint256 memory pnlAndFunding = FHEHelpers.encAddSigned(pnl, funding);
        eint256 memory totalImpact   = FHEHelpers.encAddSigned(entryImpact, exitImpact);
        eint256 memory total         = FHEHelpers.encAddSigned(pnlAndFunding, totalImpact);
        eint256 memory equity        = FHEHelpers.encAddSigned(total, collateral);

        // if insolvent => 0; else => diff
        equityNet = FHE.select(equity.sign, equity.val, ZERO);
    }

    /// @dev Price PnL buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _pnlBucket(
        Position storage p,
        uint256 price
    ) internal override returns (eint256 memory pnl) {
        // ratioX18 = 1e18 * P / E  (plaintext for sign; encrypted magnitude below)
        uint256 ratioX18 = (price * 1e18) / p.entryPrice;
        uint256 deltaX18 = ratioX18 >= 1e18 ? (ratioX18 - 1e18) : (1e18 - ratioX18);

        // Encrypted magnitude = size * |ratio - 1|
        euint256 encMagX18 = FHE.mul(p.size, FHE.asEuint256(deltaX18));

        // Price move sign (plaintext, uses public prices + side)
        ebool priceGE = FHE.asEbool(price >= p.entryPrice);
        ebool priceLT = FHE.asEbool(price < p.entryPrice);
        ebool priceGain = FHE.select(p.isLong, priceGE, priceLT);

        pnl = eint256({ sign: priceGain, val: encMagX18 });
    }

    /// @dev Funding buckets (non-negative), X18-scaled: routes magnitude to gain or loss.
    function _fundingBucket(
        Position storage p
    ) internal override returns (eint256 memory funding) {
        // dF = currentCum - entryFunding (encrypted signed)
        eint256 memory cur = FHEHelpers.select(p.isLong, cumFundingLong, cumFundingShort);
        eint256 memory dF  = FHEHelpers.encSubSigned(cur, p.entryFunding);

        // magnitude
        euint256 magX18 = FHE.mul(p.size, dF.val);

        // For long: dF >= 0 => loss; For short: same rule holds because we snapshot side-specific index.
        // returns a funding bucket where positive value => position is owed funding, negative value => position owes funding.
        ebool sign = FHE.select(dF.sign, FALSE, TRUE);
        funding = eint256({sign: sign, val: magX18});
    }
}
