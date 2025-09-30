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

    // ---------- Enums ----------
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

    // ---------- Structs ----------
    struct Validity {
        ebool requestValid;
        bool removed;
        ebool pendingDone;
        ebool toBeLiquidated;
    }

    struct InRange {
        InEuint256 low;
        InEuint256 high;
    }

    struct Range {
        euint256 low;
        euint256 high;
    }

    struct Position {
        address owner;
        uint256 positionId;
        Validity validity;
        ebool    isLong;
        euint256 size;            // notional in USDC (6 decimals, encrypted)
        uint256  collateral;      // USDC (6 decimals, plaintext)
        uint256  entryPrice;      // Chainlink price (8 decimals, plaintext)
        Range  entryPriceRange;   // Chainlink price (8 decimals, plaintext)

        // Lifecycle state
        uint256  settlementPrice; // price (8 decimals) used when AwaitingSettlement
        Status   status;
        CloseCause cause;

        // Funding index snapshot (X18, encrypted signed)
        eint256 entryFundingX18;

        uint256  pendingLiquidationPrice;

        // Encrypted price impact (entry-only), X18 non-negative buckets
        euint256 encImpactEntryGainX18; // trader gain from impact (encrypted, >=0)
        euint256 encImpactEntryLossX18; // trader loss from impact (encrypted, >=0)

        // Settlement path: encrypted equity (X18) awaiting decrypt in _settle
        euint256 pendingEquityX18;
    }

    // ===============================
    // CONSTANTS
    // ===============================
    uint256 public constant MAX_LEVERAGE_X   = 5;       // 5x
    uint256 public constant CLOSE_FEE_BPS    = 10;      // 0.1% close fee
    uint256 public constant BPS_DIVISOR      = 10_000;

    // Funding / math scales
    uint256  public constant ONE_X18          = 1e18;
    uint256  public constant MAINT_MARGIN_BPS = 100;      // 1%
    uint256  public constant MIN_NOTIONAL_USDC = 10e6;    // 10 USDC (6d)
    uint256  public constant PRICE_RANGE_BUFFER = 1e8;           // 1 USDC (8d)

    // Funding rate clamp
    uint256  public constant MAX_ABS_FUNDING_RATE_PER_SEC_X18 = 1e9; // ~0.0864%/day

    // ===== Price Impact Params (ETH-only tuning) =====
    uint256 public constant IMPACT_GAMMA_X18       = 3e15;        // 0.003 (dimensionless)
    uint256 public constant IMPACT_TVL_FACTOR_BPS  = 5000;        // 50% of pool balance
    uint256 public constant IMPACT_MIN_LIQ_USD     = 100_000e6;   // 100k USDC floor (6d)
    uint256 public constant IMPACT_UTIL_BETA_X18   = 1e18;        // strengthen impact under high |rate|
    uint256 public constant IMPACT_SCALER         = 1e14;        // units helper

    IERC20 public immutable usdc;              // 6 decimals
    IAggregatorV3 public immutable ethUsdFeed; // 8 decimals
    address public immutable keeper;

    // ===============================
    // VARIABLES
    // ===============================
    // LP accounting
    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;
    uint256 public totalLiquidity; // pool USDC (6d)
    uint256 public pendingLiquidity; // pool USDC (6d)

    // Positions
    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) internal positions;

    // -------- Funding state --------
    // signed, per second, X18
    eint256  public fundingRatePerSecX18;
    // signed cumulative indices, X18
    eint256  public cumFundingLongX18;
    eint256  public cumFundingShortX18;
    uint256  public lastFundingUpdate;

    // -------- Encrypted OI aggregates --------
    euint256 public encLongOI;  // sum of encrypted long notionals (1e6)
    euint256 public encShortOI; // sum of encrypted short notionals (1e6)

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
    
    // cross-module functions
    function _pokeFunding() internal virtual;
    function _markPrice() internal view virtual returns (uint256);
    function _setupSettlement(uint256 positionId, uint256 settlementPrice) internal virtual;

    function _encPnlBucketsX18(
        Position storage p,
        uint256 price
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);


    function _encFundingBucketsX18(
        Position storage p
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);

    function _encImpactEntryBucketsAtOpenX18(
        ebool isLong,
        euint256 encSize,
        uint256 oraclePrice
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);

    function _encImpactExitBucketsAtCloseX18(
        Position storage p,
        uint256 oraclePrice
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);

    function _settle(uint256 positionId) internal virtual returns(bool /* settled */);

    function _setFundingRateFromSkew() internal virtual;

    function _ownerEquity(uint256 positionId, uint256 price) internal virtual;

    function _openPositionFinalize(Position storage p, uint256 price) internal virtual;

    function _liquidationCheck(uint256 positionId, uint256 price) internal virtual;

    function _liquidationFinalize(uint256 positionId) internal virtual;
}
