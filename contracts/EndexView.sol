// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./EndexBase.sol";

abstract contract EndexView is EndexBase {

    struct PendingEquity {
        eint256 pnl;
        eint256 funding;
        eint256 entryImpact;
        eint256 exitImpact;
        euint256 closeFee;
        euint256 equityNet;
    }

    mapping(address => mapping(uint256 => PendingEquity)) public pendingEquity;

    function ownerEquity(
        uint256 positionId,
        uint256 price
    ) external {
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "Not owner");
        require(p.status == Status.Open, "position not open");

        _updateFunding(); // update the funding rate

        _ownerEquity(positionId, price);
    }

    function _ownerEquity(
        uint256 positionId,
        uint256 price
    ) internal override {
        Position storage p = positions[positionId];

        eint256 memory pnl = _pnlBucket(p, price);
        eint256 memory funding = _fundingBucket(p);
        eint256 memory entryImpact = p.entryImpact;
        eint256 memory exitImpact = _impactExitBucketAtClose(p, price);
        euint256 equityNet = _calcNetEquity(pnl, funding, entryImpact, exitImpact, p.collateral);
        // technically not part of net, calculating and including here for optics
        euint256 closeFee = _calcCloseFee(equityNet);

        pendingEquity[p.owner][positionId] = PendingEquity({
            pnl: pnl,
            funding: funding,
            entryImpact: entryImpact,
            exitImpact: exitImpact,
            closeFee: closeFee,
            equityNet: equityNet
        });
        
        _allowEquity(positionId, p.owner);
    }

    function _calcNetEquity(
        eint256 memory pnl, 
        eint256 memory funding,
        eint256 memory entryImpact,
        eint256 memory exitImpact,
        uint256 _collateral
    ) private returns(euint256 equityNet) {
        euint256 collX18   = FHE.asEuint256(_collateral * 1e18);
        eint256 memory collateral = eint256({sign: TRUE, val: collX18});

        eint256 memory pnlAndFunding = FHEHelpers.encAddSigned(pnl, funding);
        eint256 memory totalImpact   = FHEHelpers.encAddSigned(entryImpact, exitImpact);
        eint256 memory total         = FHEHelpers.encAddSigned(pnlAndFunding, totalImpact);
        eint256 memory equity        = FHEHelpers.encAddSigned(total, collateral);

        // if insolvent => 0; else => diff
        equityNet = FHE.select(equity.sign, equity.val, ZERO);
    }

    function _calcCloseFee(
        euint256 equityNet
    ) private returns(euint256 closeFee) {
        // Close fee on payout
        // closeFee = (payoutGross * CLOSE_FEE_BPS) / BPS_DIVISOR
        euint256 payoutGross = FHE.div(equityNet, ONE_X18);
        euint256 closeFeeNumerator = FHE.mul(payoutGross, FHE.asEuint256(CLOSE_FEE_BPS));
        closeFee = FHE.div(closeFeeNumerator, FHE.asEuint256(BPS_DIVISOR));
    }

    function _allowEquity(uint256 positionId, address owner) private {
        PendingEquity storage equity = pendingEquity[owner][positionId];
        _allowThisAndOwner(equity.pnl, owner);
        _allowThisAndOwner(equity.funding, owner);
        _allowThisAndOwner(equity.entryImpact, owner);
        _allowThisAndOwner(equity.exitImpact, owner);
        _allowThisAndOwner(equity.closeFee, owner);
        _allowThisAndOwner(equity.equityNet, owner);
    }

    function _allowThisAndOwner(eint256 storage e, address owner) private {
        _allowThisAndOwner(e.sign, owner);
        _allowThisAndOwner(e.val, owner);
    }

    function _allowThisAndOwner(euint256 val, address owner) private {
        FHE.allowThis(val);
        FHE.allow(val, owner);
    }

    function _allowThisAndOwner(ebool val, address owner) private {
        FHE.allowThis(val);
        FHE.allow(val, owner);
    }

    function _markPrice() internal view override returns (uint256) {
        (, int256 price,, ,) = feed.latestRoundData();
        require(price > 0, "price");
        return uint256(price);
    }
}
