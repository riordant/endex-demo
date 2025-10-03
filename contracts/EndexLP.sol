// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./EndexBase.sol";

/// @notice LP share management (transferable ERC20 shares) with preview helpers and
///         a minimum locked-share seed to avoid first-deposit edge cases.
///         - Shares represent pro-rata claim on `totalLiquidity` in EndexBase
///         - Math mirrors ERC-4626 style: shares = assets * totalShares / totalAssets
///         - First deposit mints MIN_SHARES to address(1)
///         - Non-reentrant
abstract contract EndexLP is EndexBase, ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------- Config ----------
    /// @dev Permanently locked seed to prevent first-depositor edge cases / rounding abuse.
    uint256 public constant MIN_LIQUIDITY_SHARES = 1_000;

    // ---------- Events ----------
    event LpDeposit(address indexed lp, uint256 assetsIn, uint256 sharesMinted);
    event LpWithdraw(address indexed lp, uint256 sharesBurned, uint256 assetsOut);

    // ---------- Views ----------
    /// @notice Total underlying managed by the pool.
    function totalAssets() public view returns (uint256) {
        return totalLiquidity; // 6 decimals (same as underlying)
    }

    /// @notice Shares a deposit of `assets` would mint at current price.
    function previewDeposit(uint256 assets) public view returns (uint256) {
        uint256 _totalAssets = totalAssets();
        uint256 _totalShares = totalSupply();

        if (assets == 0) return 0;

        if (_totalShares == 0 || _totalAssets == 0) {
            // first deposit: lock MIN_LIQUIDITY_SHARES to zero address
            // minter receives assets worth shares, minus the seed
            // price per share starts at 1:1
            require(assets > 0, "assets=0");
            // Shares minted to user = assets - MIN_SHARES, but not below zero
            return assets > MIN_LIQUIDITY_SHARES ? (assets - MIN_LIQUIDITY_SHARES) : 0;
        }

        // standard pro-rata
        return (assets * _totalShares) / _totalAssets;
    }

    /// @notice Assets a redemption of `shares` would return at current price.
    function previewRedeem(uint256 shares) public view returns (uint256) {
        uint256 _totalAssets = totalAssets();
        uint256 _totalShares = totalSupply();

        if (shares == 0) return 0;
        require(_totalShares > 0, "no shares");
        return (shares * _totalAssets) / _totalShares;
    }

    // ---------- Mutations ----------
    /// @notice Deposit underlying and mint LP shares to msg.sender.
    /// @dev Uses EndexBase.underlying for the asset; updates EndexBase.totalLiquidity.
    function lpDeposit(uint256 assets) external nonReentrant {
        require(assets > 0, "assets=0");

        // Pull tokens in
        underlying.safeTransferFrom(msg.sender, address(this), assets);

        uint256 shares = previewDeposit(assets);
        require(shares > 0, "mint=0");

        // Handle first deposit seed
        if (totalSupply() == 0 || totalAssets() == 0) {
            // lock seed to 0x1
            _mint(address(1), MIN_LIQUIDITY_SHARES);
        }

        _mint(msg.sender, shares);

        // Account assets into pool
        totalLiquidity += assets;

        emit LpDeposit(msg.sender, assets, shares);
    }

    /// @notice Burn `shares` and receive underlying to msg.sender.
    /// @dev Updates EndexBase.totalLiquidity and transfers underlying out.
    function lpWithdraw(uint256 shares) external nonReentrant {
        require(shares > 0, "shares=0");
        require(balanceOf(msg.sender) >= shares, "insufficient shares");

        uint256 assets = previewRedeem(shares);
        require(assets > 0, "assets=0");

        // Burn user shares
        _burn(msg.sender, shares);

        // Reduce pool assets and transfer
        require(assets <= totalLiquidity, "insufficient liquidity");
        totalLiquidity -= assets;
        underlying.safeTransfer(msg.sender, assets);

        emit LpWithdraw(msg.sender, shares, assets);
    }
}
