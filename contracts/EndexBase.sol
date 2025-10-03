// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
        ebool requestValid;   // Requested -> Pending flag
        ebool pendingDone;    // Pending -> Open flag
        ebool toBeLiquidated; // Open -> AwaitingSettlement -> Liquidated flag
        bool removed;         // Requested -> removed flag (not an explicit state for simplicity)
    }

    struct Range {
        euint256 low;
        euint256 high;
    }

    struct Position {
        // Trade data
        address  owner;
        uint256  positionId;
        uint256  collateral;      // underlying amount (6 decimals, plaintext)
        ebool    isLong;          // Trade direction (encrypted)
        euint256 size;            // notional in underlying (6 decimals, encrypted)
        Range    entryPriceRange; // Chainlink price range (encrypted)
        eint256 entryFunding;     // Funding index snapshot (X18, encrypted signed)
        eint256 entryImpact;      // Encrypted price impact (X18, encrypted signed)

        // plaintext prices
        uint256  entryPrice;
        uint256  pendingLiquidationPrice;
        uint256  settlementPrice;

        // Encrypted equity (X18) to be used during settlement
        euint256 pendingEquity;
        
        // State
        Validity validity;
        Status     status;
        CloseCause cause;
    }

    // ===============================
    // SHARED CONSTANTS
    // ===============================
    uint256 public constant BPS_DIVISOR                      = 10_000;  // 100%
    uint256 public constant CLOSE_FEE_BPS                    = 10;      // 0.1% close fee
    uint256 public constant MAX_ABS_FUNDING_RATE_PER_SEC_X18 = 1e10;    // ~0.0864%/day (X18 scale)

    // ===============================
    // SHARED IMMUTABLES
    // ===============================
    IERC20 public immutable underlying;        // 6 decimals
    IAggregatorV3 public immutable feed; // 8 decimals
    address public immutable keeper;

    // encrypted ciphertexts (immutable)
    ebool public immutable TRUE;                // true
    ebool public immutable FALSE;               // false
    euint256 public immutable ZERO;             // 0
    euint256 public immutable ONE;              // 1
    euint256 public immutable TWO;              // 2
    euint256 public immutable ONE_X18;          // 1e18
    euint256 public immutable MAINT_MARGIN_BPS; // 1e16: 1% (BPS -> X18)

    // ===============================
    // SHARED VARIABLES
    // ===============================
    // -------- LP accounting --------
    uint256 public totalLiquidity;    // pool liquidity (6d)
    uint256 public totalCollateral;   // pool collateral (6d)
    uint256 public pendingCollateral; // pending pool collateral (6d)

    // -------- Funding state --------
    eint256  public fundingRatePerSecond; // X18, encrypted signed
    eint256  public cumFundingLong;       // X18, encrypted signed
    eint256  public cumFundingShort;      // X18, encrypted signed
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
    constructor(IERC20 _underlying, IAggregatorV3 _feed) {
        underlying = _underlying;
        feed = _feed;

        lastFundingUpdate = block.timestamp;

        // Generate ciphertext constants
        TRUE = FHE.asEbool(true);
        FALSE = FHE.asEbool(false);
        ZERO = FHE.asEuint256(0);
        ONE = FHE.asEuint256(1);
        TWO = FHE.asEuint256(2);
        ONE_X18 = FHE.asEuint256(1e18);
        MAINT_MARGIN_BPS = FHE.asEuint256(1e16);
        
        // Generate ciphertext variables
        encLongOI = ZERO;
        encShortOI = ZERO;
        fundingRatePerSecond = eint256({ sign: TRUE, val: ZERO }); // +0
        cumFundingLong       = eint256({ sign: TRUE, val: ZERO });
        cumFundingShort      = eint256({ sign: TRUE, val: ZERO });

        // Permissions for ciphertexts
        FHE.allowThis(TRUE);
        FHE.allowThis(FALSE);
        FHE.allowThis(ZERO);
        FHE.allowThis(ONE);
        FHE.allowThis(TWO);
        FHE.allowThis(ONE_X18);
        FHE.allowThis(MAINT_MARGIN_BPS);
        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        FHEHelpers.allowThis(fundingRatePerSecond);
        FHEHelpers.allowThis(cumFundingLong);
        FHEHelpers.allowThis(cumFundingShort);
    }
    
    // ===============================
    // SHARED FUNCTIONS
    // ===============================
    // Funding
    function _updateFunding() internal virtual;

    function _setFundingRateFromSkew() internal virtual;

    // Impact
    function _impactEntryBucketAtOpen(
        ebool isLong,
        euint256 encSize,
        uint256 oraclePrice
    ) internal virtual returns (eint256 memory entryImpact);

    function _impactExitBucketAtClose(
        Position storage p,
        uint256 oraclePrice
    ) internal virtual returns (eint256 memory exitImpact);

    // Liquidation
    function _liquidationCheck(uint256 positionId, uint256 price) internal virtual;

    function _liquidationFinalize(uint256 positionId) internal virtual;

    // Settlement
    function _settlementFinalize(uint256 positionId) internal virtual returns(bool /* settled */);

    function _settlementInitialize(uint256 positionId, uint256 settlementPrice) internal virtual;

    function _pnlBucket(
        Position storage p,
        uint256 price
    ) internal virtual returns (eint256 memory pnl);

    function _fundingBucket(
        Position storage p
    ) internal virtual returns (eint256 memory funding);

    // Trading
    function _openPositionFinalize(Position storage p, uint256 price) internal virtual;

    // View
    function _markPrice() internal view virtual returns (uint256);

    function _ownerEquity(uint256 positionId, uint256 price) internal virtual;
}
