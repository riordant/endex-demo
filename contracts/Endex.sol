// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexView.sol";

contract Endex is EndexView {
    constructor(IERC20 _usdc, IAggregatorV3 _feed)
        EndexView(_usdc, _feed)
    {}
}
