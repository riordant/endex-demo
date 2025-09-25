// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {eint256} from "../libs/FHEHelpers.sol";

interface IEndex {
    // ---------- Enums ----------

    enum Status {
        Open,
        AwaitingSettlement,
        Liquidated,
        Closed
    }

    enum CloseCause {
        UserClose,
        Liquidation,
        TakeProfit,
        StopLoss
    }

    // ---------- Position ----------

    struct Position {
        address owner;
        uint256 positionId;
        bool    isLong;

        // Core economic state
        euint256 size;            // notional in USDC (6 decimals, encrypted)
        uint256  collateral;      // USDC (6 decimals, plaintext)
        uint256  entryPrice;      // Chainlink price (8 decimals, plaintext)

        // Lifecycle state
        uint256  settlementPrice; // price (8 decimals) used when AwaitingSettlement
        Status   status;
        CloseCause cause;

        // Funding index snapshot (X18, encrypted signed)
        eint256 entryFundingX18;

        // Encrypted liquidation trigger workflow
        euint256 pendingLiqFlagEnc; // 0/1 encrypted
        uint256  pendingLiqCheckPrice;
        bool     liqCheckPending;

        // Encrypted price impact (entry-only), X18 non-negative buckets
        euint256 encImpactEntryGainX18; // trader gain from impact (encrypted, >=0)
        euint256 encImpactEntryLossX18; // trader loss from impact (encrypted, >=0)

        // Settlement path: encrypted equity (X18) awaiting decrypt in _settle
        euint256 pendingEquityX18;
    }

    // ---------- Events ----------
    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        bool isLong,
        euint256 size,
        uint256 collateral,
        uint256 entryPrice
    );

    event PositionClosed(
        uint256 indexed positionId,
        address indexed owner,
        int256 pnl,          // kept for compatibility; 0 when using encrypted equity path
        uint256 payout,      // net payout to user (after fee)
        Status status,       // Closed or Liquidated
        uint256 closePrice,  // settlementPrice used
        uint256 feePaid
    );

    event LpDeposit(address indexed lp, uint256 amount, uint256 sharesMinted);
    event LpWithdraw(address indexed lp, uint256 shares, uint256 amountReturned);

    // ---------- Trading API ----------
    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral
    ) external;

    function closePosition(uint256 positionId) external;
    function settlePositions(uint256[] calldata positionIds) external;
    function getPosition(uint256 positionId) external view returns (Position memory);
    function nextPositionId() external view returns (uint256);

    // ---------- Encrypted liquidation trigger (two-step) ----------
    function requestLiqChecks(uint256[] calldata positionIds) external;
    function finalizeLiqChecks(uint256[] calldata positionIds) external;
}
