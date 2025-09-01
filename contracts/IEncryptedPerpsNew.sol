// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IEncryptedPerpsNew {
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
        euint256 size; // notional in USDC (6 decimals, encrypted)
        uint256 collateral; // USDC (6 decimals, plaintext)
        uint256 entryPrice; // Chainlink price (8 decimals, plaintext)
        uint256 liquidationPrice; // price (8 decimals)  // TODO: compute internally in next step
        uint256 stopLossPrice; // price (8 decimals)     // TODO: move to encrypted in future
        uint256 takeProfitPrice; // price (8 decimals)   // TODO: move to encrypted in future
        uint256 settlementPrice; // price (8 decimals)
        Status status;

        // NEW: snapshot of cumulative funding at entry (X18, signed)
        int256 entryFundingX18;

        // NEW: pending encrypted liquidation flag + snapshot price for encrypted-trigger workflow
        euint256 pendingLiqFlagEnc; // 0/1 encrypted
        uint256 pendingLiqCheckPrice;
        bool     liqCheckPending;
    }

    // Existing events
    event PositionOpened(uint256 indexed positionId, address indexed owner, bool isLong, euint256 size, uint256 collateral, uint256 entryPrice);
    event PositionClosed(uint256 indexed positionId, address indexed owner, int256 pnl, uint256 payout, Status status, uint256 closePrice, uint256 feePaid);
    event ChecksRequested(uint80 roundId, uint256[] positionIds);

    // NEW: funding & OI events
    event FundingAccrued(int256 ratePerSecX18, int256 cumLongX18, int256 cumShortX18, uint256 timestamp);
    event EncryptedOIUpdated(bool isLong, bool added, uint256 positionId);
    event FundingRateRequested(uint64 epoch);
    event FundingRateCommitted(int256 newRatePerSecX18, uint64 epoch);

    // Trading API (existing)
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

    // NEW: funding index API
    function pokeFunding() external; // accrues cumFunding using current rate
    function requestFundingRateFromSkew() external; // compute enc-skew -> request decrypt of rate numerator
    function commitFundingRate(uint64 epoch) external; // finalize funding rate update (after decrypt ready)

    // NEW: encrypted liquidation trigger (two-step)
    function requestLiqChecks(uint256[] calldata positionIds) external;
    function finalizeLiqChecks(uint256[] calldata positionIds) external;
}
