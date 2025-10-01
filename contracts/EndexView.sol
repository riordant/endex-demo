// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexView is EndexBase {

    function ownerEquity(
        uint256 positionId,
        uint256 price
    ) external {
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "Not owner");
        require(p.status == Status.Open, "position not open");

        _pokeFunding(); // update the funding rate

        _ownerEquity(positionId, price);
    }

    function _ownerEquity(
        uint256 positionId,
        uint256 price
    ) internal override {
        Position storage p = positions[positionId];

        Net memory pnl;
        Net memory funding;
        Net memory entryImpact;
        Net memory exitImpact;

        (pnl.gainX18, pnl.lossX18) = _encPnlBucketsX18(p, price);
        (funding.gainX18, funding.lossX18)  = _encFundingBucketsX18(p);
        entryImpact = Net(p.encImpactEntryGainX18, p.encImpactEntryLossX18);
        (exitImpact.gainX18, exitImpact.lossX18) = _encImpactExitBucketsAtCloseX18(p, price);
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
        Net memory pnl, 
        Net memory funding,
        Net memory entryImpact,
        Net memory exitImpact,
        uint256 collateral
    ) private returns(euint256 equityNet) {
        euint256 gainX18  = FHE.add(pnl.gainX18, funding.gainX18);
        gainX18           = FHE.add(gainX18,  entryImpact.gainX18);
        gainX18           = FHE.add(gainX18,  exitImpact.gainX18);

        euint256 lossX18  = FHE.add(pnl.lossX18, funding.lossX18);
        lossX18           = FHE.add(lossX18,  entryImpact.lossX18);
        lossX18           = FHE.add(lossX18,  exitImpact.lossX18);

        euint256 collX18   = FHE.asEuint256(collateral * ONE_X18);
        euint256 lhs       = FHE.add(collX18, gainX18);

        // equity = max(0, lhs - losses)
        ebool insolvent    = FHE.lt(lhs, lossX18);
        euint256 diff      = FHE.sub(FHE.select(insolvent, lossX18, lhs),
                                     FHE.select(insolvent, lhs,     lossX18));
        // if insolvent => 0; else => diff
        equityNet = FHE.select(insolvent, FHE.asEuint256(0), diff);
    }

    function _calcCloseFee(
        euint256 equityNet
    ) private returns(euint256 closeFee) {
        // Close fee on payout
        // closeFee = (payoutGross * CLOSE_FEE_BPS) / BPS_DIVISOR
        euint256 payoutGross = FHE.div(equityNet, FHE.asEuint256(ONE_X18));
        euint256 closeFeeNumerator = FHE.mul(payoutGross, FHE.asEuint256(CLOSE_FEE_BPS));
        closeFee = FHE.div(closeFeeNumerator, FHE.asEuint256(BPS_DIVISOR));
    }

    function _allowEquity(uint256 positionId, address owner) private {
        PendingEquity storage equity = pendingEquity[owner][positionId];
        _allowNet(equity.pnl, owner);
        _allowNet(equity.funding, owner);
        _allowNet(equity.entryImpact, owner);
        _allowNet(equity.exitImpact, owner);
        _allowWithSender(equity.closeFee, owner);
        _allowWithSender(equity.equityNet, owner);
    }

    function _allowNet(Net storage net, address owner) private {
        _allowWithSender(net.gainX18, owner);
        _allowWithSender(net.lossX18, owner);
    }

    function _allowWithSender(euint256 val, address owner) private {
        FHE.allowThis(val);
        FHE.allow(val, owner);
    }

    function _markPrice() internal view override returns (uint256) {
        (, int256 price,, ,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");
        return uint256(price);
    }
}
