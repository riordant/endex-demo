// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IEncryptedPerps {
    enum Status {
        Open,
        AwaitingSettlement,
        Liquidated,
        Closed
    }

    struct Position {
        address owner;
        uint256 positionId;
        bool isLong;
        euint256 size; // notional in USDC (6 decimals)
        uint256 collateral; // USDC (6 decimals)
        uint256 entryPrice; // Chainlink price (8 decimals)
        uint256 liquidationPrice; // price (8 decimals)
        uint256 stopLossPrice; // price (8 decimals)
        uint256 takeProfitPrice; // price (8 decimals)
        uint256 settlementPrice; // price (8 decimals)
        Status status;
    }

    event PositionOpened(uint256 indexed positionId, address indexed owner, bool isLong, euint256 size, uint256 collateral, uint256 entryPrice);
    event PositionClosed(uint256 indexed positionId, address indexed owner, int256 pnl, uint256 payout, Status status, uint256 closePrice, uint256 feePaid);
    event ChecksRequested(uint80 roundId, uint256[] positionIds);

    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice,
        uint256 liquidationPrice
    ) external;

    function closePosition(uint256 positionId) external;

    function settlePositions(uint256[] calldata positionIds) external;

    function checkPositions(uint256[] calldata positionIds) external;

    function getPosition(uint256 positionId) external view returns (Position memory);
}


