// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";
import "./EndexFunding.sol";
import "./EndexImpact.sol";
import "./EndexLP.sol";
import "./EndexSettlement.sol";
import "./EndexView.sol";
import "./EndexTrading.sol";
import "./EndexLiquidation.sol";

contract Endex is
    EndexBase,
    EndexFunding,
    EndexImpact,
    EndexLP,
    EndexSettlement,
    EndexView,
    EndexTrading,
    EndexLiquidation
{
    constructor(IERC20 _usdc, IAggregatorV3 _feed)
        EndexBase(_usdc, _feed)
    {}
}
