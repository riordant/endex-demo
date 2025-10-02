// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./libs/FHEHelpers.sol";
import "hardhat/console.sol";

abstract contract EndexBase {
    using FHEHelpers for *;
    using SafeERC20 for IERC20;

    // ===============================
    // SHARED ENUMS
    // ===============================
    enum Status {
        Requested,
        Pending,
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

    // ===============================
    // SHARED STRUCTS
    // ===============================
    struct Validity {
        ebool requestValid;
        bool removed;
        ebool pendingDone;
        ebool toBeLiquidated;
    }

    struct Range {
        euint256 low;
        euint256 high;
    }

    struct Position {
        address  owner;
        uint256  positionId;
        ebool    isLong;
        euint256 size;            // notional in USDC (6 decimals, encrypted)
        Range    entryPriceRange; // Chainlink price range (encrypted)
        uint256  collateral;      // USDC (6 decimals, plaintext)
        eint256 entryFunding;     // Funding index snapshot (X18, encrypted signed)
        eint256 entryImpact;      // Encrypted price impact (X18, encrypted signed)

        // plaintext prices
        uint256  entryPrice;                // price when Open
        uint256  pendingLiquidationPrice;
        uint256  settlementPrice;

        // Settlement path: encrypted equity (X18) awaiting decrypt in _settle
        euint256 pendingEquityX18;

        Validity validity;
        Status     status;
        CloseCause cause;
    }

    // ===============================
    // SHARED CONSTANTS
    // ===============================
    uint256 public constant CLOSE_FEE_BPS                    = 10;     // 0.1% close fee
    uint256 public constant BPS_DIVISOR                      = 10_000;
    uint256 public constant ONE_X18                          = 1e18;
    uint256 public constant MAX_ABS_FUNDING_RATE_PER_SEC_X18 = 1e9;    // ~0.0864%/day

    // ===============================
    // SHARED IMMUTABLES
    // ===============================
    IERC20 public immutable usdc;              // 6 decimals
    IAggregatorV3 public immutable ethUsdFeed; // 8 decimals
    address public immutable keeper;

    // ===============================
    // SHARED VARIABLES
    // ===============================
    // LP accounting
    uint256 public totalLiquidity; // pool USDC (6d)
    uint256 public totalCollateral; // pool collateral (6d)
    uint256 public pendingCollateral; // pending pool collateral (6d)

    // -------- Funding state --------
    eint256  public fundingRatePerSecX18;
    eint256  public cumFundingLongX18;
    eint256  public cumFundingShortX18;
    uint256  public lastFundingUpdate;

    // -------- Encrypted OI aggregates --------
    euint256 public encLongOI;  // sum of encrypted long notionals (1e6)
    euint256 public encShortOI; // sum of encrypted short notionals (1e6)

    // ===============================
    // SHARED MAPPINGS
    // ===============================
    mapping(uint256 => Position) internal positions;

    // ===============================
    // CONSTRUCTOR
    // ===============================
    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed, address _keeper) {
        usdc = _usdc;
        ethUsdFeed = _ethUsdFeed;
        keeper = _keeper;

        lastFundingUpdate = block.timestamp;

        encLongOI = FHEHelpers._zero();
        encShortOI = FHEHelpers._zero();

        // init encrypted signed states as zero
        fundingRatePerSecX18 = eint256({ sign: FHE.asEbool(true), val: FHEHelpers._zero() }); // +0
        cumFundingLongX18    = eint256({ sign: FHE.asEbool(true), val: FHEHelpers._zero() });
        cumFundingShortX18   = eint256({ sign: FHE.asEbool(true), val: FHEHelpers._zero() });

        // Permissions for ciphertexts used by this contract
        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        FHEHelpers._allowEint256(fundingRatePerSecX18);
        FHEHelpers._allowEint256(cumFundingLongX18);
        FHEHelpers._allowEint256(cumFundingShortX18);
    }
    
    // ===============================
    // SHARED FUNCTIONS
    // ===============================
    // Funding
    function _pokeFunding() internal virtual;

    function _setFundingRateFromSkew() internal virtual;

    // Impact
    function _impactEntryBucketsAtOpen(
        ebool isLong,
        euint256 encSize,
        uint256 oraclePrice
    ) internal virtual returns (eint256 memory entryImpact);

    function _impactExitBucketsAtClose(
        Position storage p,
        uint256 oraclePrice
    ) internal virtual returns (eint256 memory exitImpact);

    // Liquidation
    function _liquidationCheck(uint256 positionId, uint256 price) internal virtual;

    function _liquidationFinalize(uint256 positionId) internal virtual;

    // Settlement
    function _settle(uint256 positionId) internal virtual returns(bool /* settled */);

    function _setupSettlement(uint256 positionId, uint256 settlementPrice) internal virtual;

    function _pnlBuckets(
        Position storage p,
        uint256 price
    ) internal virtual returns (eint256 memory pnl);

    function _fundingBuckets(
        Position storage p
    ) internal virtual returns (eint256 memory funding);

    // Trading
    function _openPositionFinalize(Position storage p, uint256 price) internal virtual;

    // View
    function _markPrice() internal view virtual returns (uint256);

    function _ownerEquity(uint256 positionId, uint256 price) internal virtual;
}
