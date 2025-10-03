// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./EndexBase.sol";
import "./EndexFunding.sol";
import "./EndexImpact.sol";
import "./EndexKeeper.sol";
import "./EndexLiquidation.sol";
import "./EndexLP.sol";
import "./EndexSettlement.sol";
import "./EndexTrading.sol";
import "./EndexView.sol";

contract Endex is
    EndexBase,
    EndexFunding,
    EndexImpact,
    EndexKeeper,
    EndexLiquidation,
    EndexLP,
    EndexSettlement,
    EndexTrading,
    EndexView
{
    constructor(IERC20 _underlying, IAggregatorV3 _feed)
        EndexBase(_underlying, _feed)
        ERC20("Endex LP Share", "ELS")
    {}
}
