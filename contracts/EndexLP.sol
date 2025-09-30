// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexLP is EndexBase {
    using SafeERC20 for IERC20;

    event LpDeposit(address indexed lp, uint256 amount, uint256 sharesMinted);
    event LpWithdraw(address indexed lp, uint256 shares, uint256 amountReturned);

    function lpDeposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 shares = totalLpShares == 0 ? amount : (amount * totalLpShares) / totalLiquidity;
        lpShares[msg.sender] += shares;
        totalLpShares += shares;
        totalLiquidity += amount;
        emit LpDeposit(msg.sender, amount, shares);
    }

    function lpWithdraw(uint256 shares) external {
        require(shares > 0 && shares <= lpShares[msg.sender], "bad shares");
        uint256 amount = (shares * totalLiquidity) / totalLpShares;
        lpShares[msg.sender] -= shares;
        totalLpShares -= shares;
        totalLiquidity -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit LpWithdraw(msg.sender, shares, amount);
    }
}
