// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import {IEncryptedPerps} from "./IEncryptedPerps.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "hardhat/console.sol";

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

contract SimpleEncryptedPerps is IEncryptedPerps {
    using SafeERC20 for IERC20;

    // Constants
    uint256 public constant MAX_LEVERAGE_X = 5; // 5x
    uint256 public constant CLOSE_FEE_BPS = 10; // 0.1% close fee
    uint256 public constant BPS_DIVISOR = 10_000;

    // Tokens and oracle
    IERC20 public immutable usdc; // 6 decimals
    IAggregatorV3 public immutable ethUsdFeed; // 8 decimals

    // LP accounting
    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;
    uint256 public usdcBalance; // contract USDC controlled balance for pool

    // Positions
    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) internal positions;

    // Keeper heartbeat state (last observed round)
    uint80 public lastRoundId;

    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed) {
        usdc = _usdc;
        ethUsdFeed = _ethUsdFeed;
    }

    // -------- LP functions (simple pool) --------

    event LpDeposit(address indexed lp, uint256 amount, uint256 sharesMinted);
    event LpWithdraw(address indexed lp, uint256 shares, uint256 amountReturned);

    function lpDeposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 shares = totalLpShares == 0 ? amount : (amount * totalLpShares) / usdcBalance;
        lpShares[msg.sender] += shares;
        totalLpShares += shares;
        usdcBalance += amount;
        emit LpDeposit(msg.sender, amount, shares);
    }

    function lpWithdraw(uint256 shares) external {
        require(shares > 0 && shares <= lpShares[msg.sender], "bad shares");
        uint256 amount = (shares * usdcBalance) / totalLpShares;
        lpShares[msg.sender] -= shares;
        totalLpShares -= shares;
        usdcBalance -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit LpWithdraw(msg.sender, shares, amount);
    }

    // -------- Trading API --------

    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice,
        uint256 liquidationPrice
    ) external override {
        // Leverage = size / collateral <= 5x
        //require(size <= collateral * MAX_LEVERAGE_X, "leverage>5x");

        // we cannot use requires for validation on encrypted values
        // so we instead set size to max_leverage if a greater size is chosen
        // size = (size > collateral * MAX_LEVERAGE) ? collateral * MAX_LEVERAGE : size
        // TODO handle collateral being less than size
        euint256 _size = FHE.asEuint256(size_);
        euint256 max_size = FHE.asEuint256(collateral * MAX_LEVERAGE_X);
        euint256 size = FHE.select(FHE.gt(_size, max_size), max_size, _size);

        // Pull collateral
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        usdcBalance += collateral;

        // Get entry price
        (, int256 price,,,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");

        uint256 id = nextPositionId++;
        positions[id] = Position({
            owner: msg.sender,
            positionId: id,
            isLong: isLong,
            size: size,
            collateral: collateral,
            entryPrice: uint256(price),
            liquidationPrice: liquidationPrice,
            stopLossPrice: stopLossPrice,
            takeProfitPrice: takeProfitPrice,
            settlementPrice: 0,
            status: Status.Open
        });

        FHE.allowThis(size);
        FHE.allowSender(size);

        emit PositionOpened(id, msg.sender, isLong, size, collateral, uint256(price));
    }

    function closePosition(uint256 positionId) external override {
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "not owner");
        require(p.status == Status.Open, "not open");

        _setupSettlement(p, _markPrice());
    }

    function settlePositions(uint256[] calldata positionIds) external override {
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            Position storage p = positions[id];
            if (!(p.status == Status.AwaitingSettlement)) {
                continue;
            }
            _settle(id);
        }
    }

    function checkPositions(uint256[] calldata positionIds) external override {
        (uint80 rid,, , ,) = ethUsdFeed.latestRoundData();
        if (rid == lastRoundId) return;
        lastRoundId = rid;

        uint256 price = _markPrice();
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            Position storage p = positions[id];
            if (p.status != Status.Open) { continue; }

            bool hitTp = p.takeProfitPrice > 0 && (p.isLong ? price >= p.takeProfitPrice : price <= p.takeProfitPrice);
            bool hitSl = p.stopLossPrice > 0 && (p.isLong ? price <= p.stopLossPrice : price >= p.stopLossPrice);
            bool hitLiq = p.liquidationPrice > 0 && (p.isLong ? price <= p.liquidationPrice : price >= p.liquidationPrice);

            if (hitTp || hitSl || hitLiq) {
                _setupSettlement(p, price);
            }
        }
    }

    function getPosition(uint256 positionId) external view override returns (Position memory) {
        return positions[positionId];
    }

    // -------- Internal --------

    function _markPrice() internal view returns (uint256) {
        (, int256 price,, ,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");
        return uint256(price);
    }

    function _setupSettlement(Position storage p, uint256 settlementPrice) internal {
        console.log("decrypting..");
        FHE.decrypt(p.size);
        console.log("decrypted call done..");
        p.status = Status.AwaitingSettlement;
        p.settlementPrice = settlementPrice;
    }

    function _settle(uint256 positionId) internal {
        Position storage p = positions[positionId];
        require(p.status == Status.AwaitingSettlement, "not awaiting settlement");

        (uint256 size, bool sizeReady) = FHE.getDecryptResultSafe(p.size);
        require(sizeReady, "Size not yet decrypted");

        // PnL in USDC units (size uses 6d, prices 8d). Normalize by 1e8.
        // Long: size * (price/entry - 1)
        // Short: size * (1 - price/entry)
        int256 pnl;
        uint256 price = p.settlementPrice;
        if (p.isLong) {
            pnl = int256(size) * (int256(price) - int256(p.entryPrice)) / int256(p.entryPrice);
        } else {
            pnl = int256(size) * (int256(p.entryPrice) - int256(price)) / int256(p.entryPrice);
        }

        // Close fee on payout only when closing
        int256 payoutGross = int256(p.collateral) + pnl;
        if (payoutGross < 0) {
            payoutGross = 0;
        }
        uint256 fee = (uint256(payoutGross) * CLOSE_FEE_BPS) / BPS_DIVISOR;
        int256 payoutNet = payoutGross - int256(fee);

        // Update pool balance
        if (payoutNet > 0) {
            require(uint256(payoutNet) <= usdcBalance, "pool insolvent");
            usdcBalance -= uint256(payoutNet);
            usdc.safeTransfer(p.owner, uint256(payoutNet));
        }

        // Fee stays in pool (accrues to LPs)
        // If payoutGross == 0, fee = 0

        // Mark status
        p.status = payoutGross == 0 && (p.isLong ? price <= p.liquidationPrice : price >= p.liquidationPrice) ? Status.Liquidated : Status.Closed;

        emit PositionClosed(positionId, p.owner, pnl, uint256(payoutNet < 0 ? int256(0) : payoutNet), p.status, price, fee);
    }
}


