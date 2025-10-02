// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexTrading is EndexBase {
    using FHEHelpers for *;
    using SafeERC20 for IERC20;

    // ===============================
    // CONSTANTS
    // ===============================
    uint256 public constant MAX_LEVERAGE_X     =    5; // 5x
    uint256 public constant MIN_NOTIONAL_USDC  = 10e6; // 10 USDC (6d)
    uint256 public constant PRICE_RANGE_BUFFER =  1e8; // 1 USDC (8d)

    uint256 public nextPositionId = 1;

    struct InRange {
        InEuint256 low;
        InEuint256 high;
    }

    function openPositionRequest(
        InEbool calldata isLong_,
        InEuint256 calldata size_,
        InRange calldata entryPriceRange_,
        uint256 collateral
    ) external virtual {
        _openPositionRequest(
            isLong_,
            size_,
            entryPriceRange_,
            collateral
        );
    }

    function _openPositionRequest(
        InEbool calldata isLong_,
        InEuint256 calldata size_,
        InRange calldata entryPriceRange_,
        uint256 collateral
    ) internal {
        _pokeFunding();
        uint256 price = _markPrice();

        // get inputs 
        ebool isLong = FHE.asEbool(isLong_);
        euint256 size  = FHE.asEuint256(size_);
        Range memory range = Range({
            low: FHE.asEuint256(entryPriceRange_.low),
            high: FHE.asEuint256(entryPriceRange_.high)
        });

        // validations: size, and entry price range
        ebool sizeValid = _validateSize(size, collateral);
        ebool rangeValid = _validateRange(range);
        ebool requestValid = FHE.and(sizeValid, rangeValid);
        Validity memory validity = Validity({
            requestValid: requestValid,
            removed: false,
            pendingDone: FHE.asEbool(false),
            toBeLiquidated: FHE.asEbool(false)
        });

        // Pull collateral into pendingCollateral
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        pendingCollateral += collateral;

        // set position
        uint256 id = nextPositionId++;
        positions[id] = Position({
            owner: msg.sender,
            positionId: id,
            validity: validity,
            isLong: isLong,
            size: size,
            collateral: collateral,
            entryPrice: uint256(price),
            entryPriceRange: range,
            settlementPrice: 0,
            status: Status.Requested,
            cause: CloseCause.UserClose, // default
            entryFunding: FHEHelpers._zeroEint256(),
            pendingLiquidationPrice: 0,
            entryImpact: FHEHelpers._zeroEint256(),
            pendingEquityX18: FHEHelpers._zero()
        });
        
        // FHE allow position
        _allowPosition(positions[id]);
    }

    function _openPositionFinalize(
        Position storage p,
        uint256 price
    ) internal override {
        console.log("open position finalize..");
        // Put collateral into total
        pendingCollateral -= p.collateral;
        totalCollateral += p.collateral;

        // --- Entry price impact buckets (encrypted) BEFORE updating OI ---
        eint256 memory entryImpact = _impactEntryBucketsAtOpen(p.isLong, p.size, price);

        // Snapshot entry funding (encrypted signed)
        eint256 memory entryFunding = FHEHelpers._selectEint(p.isLong, cumFundingLongX18, cumFundingShortX18);

        // Update encrypted OI aggregates (AFTER recording entry impact based on pre-trade OI)
        // both values updated for privacy
        // (isLong) ? encLongOI += size : encShortOI += size
        console.log("update OI..");
        encLongOI = FHE.add(encLongOI, FHE.select(p.isLong, p.size, FHEHelpers._zero()));
        encShortOI = FHE.add(encShortOI, FHE.select(p.isLong, FHEHelpers._zero(), p.size));

        // Update funding rate for future accruals
        console.log("update skew..");
        _setFundingRateFromSkew();

        // set values back on the position
        p.entryPrice = price;
        p.entryFunding = entryFunding;
        p.entryImpact = entryImpact;

        // TODO: global is just for tests, and allowPosition not everything is needed.
        _allowFunding_Global();
        _allowPosition(p);
    }

    function _allowFunding_Global() internal {
        _allowEint256_Global(fundingRatePerSecX18);
        _allowEint256_Global(cumFundingLongX18);
        _allowEint256_Global(cumFundingShortX18);
        FHE.allowGlobal(encLongOI);
        FHE.allowGlobal(encShortOI);
    }

    function _allowEint256_Global(eint256 storage a) internal {
        FHE.allowGlobal(a.sign);
        FHE.allowGlobal(a.val);
    }


    /// @dev Validate MIN_NOTIONAL_USDC <= size <= collateral * MAX_LEVERAGE_X.
    function _validateSize(euint256 _size, uint256 collateral) internal returns (ebool) {
        // 
        euint256 min = FHE.asEuint256(MIN_NOTIONAL_USDC);
        euint256 max = FHE.asEuint256(collateral * MAX_LEVERAGE_X);

        ebool sizeGTE = FHE.gte(_size, min);
        ebool sizeLTE = FHE.lte(_size, max);

        return FHE.and(sizeGTE, sizeLTE);
    }

    /// @dev Validate (low + BUFFER) < high
    function _validateRange(Range memory _range) internal returns (ebool) {
        euint256 buffer = FHE.add(_range.low, FHE.asEuint256(PRICE_RANGE_BUFFER));
        return FHE.lt(buffer, _range.high);
    }

    function _allowPosition(Position storage p) internal {
        Validity storage v = p.validity;
        Range storage er = p.entryPriceRange;

        // decrypt and make validity vars available to all users
        FHE.allowGlobal(v.requestValid);
        FHE.allowGlobal(v.pendingDone);
        FHE.allowGlobal(v.toBeLiquidated);
        FHE.decrypt(v.requestValid);
        FHE.decrypt(v.pendingDone);
        FHE.decrypt(v.toBeLiquidated);

        FHE.allowSender(p.isLong);
        FHE.allowThis(p.isLong);

        FHE.allowSender(p.size);
        FHE.allowThis(p.size);

        FHE.allowThis(er.low);
        FHE.allowThis(er.high);

        FHE.allowThis(p.pendingEquityX18);
        FHE.allowGlobal(p.pendingEquityX18);
        FHEHelpers._allowEint256(p.entryFunding);
        FHEHelpers._allowEint256(p.entryImpact);
    }

    function closePosition(uint256 positionId) external {
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "not owner");
        require(p.status == Status.Open, "not open");
        p.cause = CloseCause.UserClose;
        _setupSettlement(positionId, _markPrice());
    }

    function settlePositions(uint256[] calldata positionIds) external {
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            Position storage p = positions[id];
            if (p.status != Status.AwaitingSettlement) continue;
            _settle(id);
        }
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }
}
