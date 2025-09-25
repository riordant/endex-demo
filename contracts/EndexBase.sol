// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import {IEndex} from "./interfaces/IEndex.sol";
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
    // CONSTANTS
    // ===============================
    uint256 public constant MAX_LEVERAGE_X   = 5;       // 5x
    uint256 public constant CLOSE_FEE_BPS    = 10;      // 0.1% close fee
    uint256 public constant BPS_DIVISOR      = 10_000;

    // Funding / math scales
    uint256  public constant ONE_X18          = 1e18;
    uint256  public constant MAINT_MARGIN_BPS = 100;      // 1%
    uint256  public constant MIN_NOTIONAL_USDC = 10e6;    // 10 USDC (6d)

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

    // ===============================
    // VARIABLES
    // ===============================
    // LP accounting
    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;
    uint256 public usdcBalance; // pool USDC (6d)

    // Positions
    uint256 public nextPositionId = 1;
    mapping(uint256 => IEndex.Position) internal positions;

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
    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed) {
        usdc = _usdc;
        ethUsdFeed = _ethUsdFeed;

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
    function _setupSettlement(IEndex.Position storage p, uint256 settlementPrice) internal virtual;

    function _encPnlBucketsX18(
        IEndex.Position storage p,
        uint256 price
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);


    function _encFundingBucketsX18(
        IEndex.Position storage p
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);

    function _encImpactEntryBucketsAtOpenX18(
        bool isLong,
        euint256 encSize,
        uint256 oraclePrice
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);

    function _encImpactExitBucketsAtCloseX18(
        IEndex.Position storage p,
        uint256 oraclePrice
    ) internal virtual returns (euint256 gainX18, euint256 lossX18);

    function _settle(uint256 positionId) internal virtual;

    function _setFundingRateFromSkew() internal virtual;
}
