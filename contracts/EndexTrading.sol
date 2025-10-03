// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./EndexBase.sol";

abstract contract EndexTrading is EndexBase {
    using FHEHelpers for *;
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LEVERAGE_X     =    5; // 5x
    uint256 public constant MIN_SIZE           = 10e6; // 10 underlying (6d)
    uint256 public constant PRICE_RANGE_BUFFER =  1e8; // 1 underlying (8d)
    uint256 public constant OI_CAP_BPS_TOTAL   = 7000; // 70% TVL
    uint256 public constant OI_CAP_BPS_LONG    = 5000; // 50% TVL
    uint256 public constant OI_CAP_BPS_SHORT   = 5000; // 50% TVL


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
        _updateFunding();

        // get inputs 
        ebool isLong = FHE.asEbool(isLong_);
        euint256 size  = FHE.asEuint256(size_);
        Range memory range = Range({
            low: FHE.asEuint256(entryPriceRange_.low),
            high: FHE.asEuint256(entryPriceRange_.high)
        });
        
        // create validation object
        Validity memory validity = Validity({
            requestValid: _validateRequest(isLong, size, range, collateral),
            pendingDone: FALSE,
            toBeLiquidated: FALSE,
            removed: false
        });

        // Pull collateral into pendingCollateral
        underlying.safeTransferFrom(msg.sender, address(this), collateral);
        pendingCollateral += collateral;

        // set position
        uint256 id = nextPositionId++;
        positions[id] = Position({
            owner: msg.sender,
            positionId: id,
            collateral: collateral,
            isLong: isLong,
            size: size,
            entryPriceRange: range,
            entryFunding: FHEHelpers.zeroEint256(),
            entryImpact: FHEHelpers.zeroEint256(),
            entryPrice: 0,
            pendingLiquidationPrice: 0,
            settlementPrice: 0,
            pendingEquity: ZERO,
            validity: validity,
            status: Status.Requested,
            cause: CloseCause.UserClose // default
        });
        
        // FHE allow position
        _allowPositionRequest(positions[id]);
    }

    function _openPositionFinalize(
        Position storage p,
        uint256 price
    ) internal virtual override {
        __openPositionFinalize(
            p,
            price
        );
    }

    function __openPositionFinalize(
        Position storage p,
        uint256 price
    ) internal {
        // Put collateral into total
        pendingCollateral -= p.collateral;
        totalCollateral += p.collateral;

        // --- Entry price impact bucket (encrypted) BEFORE updating OI ---
        eint256 memory entryImpact = _impactEntryBucketAtOpen(p.isLong, p.size, price);

        // Snapshot entry funding (encrypted signed)
        eint256 memory entryFunding = FHEHelpers.select(p.isLong, cumFundingLong, cumFundingShort);

        // Update encrypted OI aggregates (AFTER recording entry impact based on pre-trade OI)
        // both values updated for privacy
        // (isLong) ? encLongOI += size : encShortOI += size
        encLongOI  = FHE.add( encLongOI, FHE.select(p.isLong, p.size, ZERO));
        encShortOI = FHE.add(encShortOI, FHE.select(p.isLong, ZERO, p.size));

        // Update funding rate for future accruals
        _setFundingRateFromSkew();

        // set values back on the position
        p.entryPrice = price;
        p.entryFunding = entryFunding;
        p.entryImpact = entryImpact;
        
        // allow updated values
        _allowPositionFinalize(p);
    }

    /// @dev Validations: size, caps, entry price (range)
    function _validateRequest(ebool isLong, euint256 size, Range memory range, uint256 collateral) internal returns(ebool) {
        ebool sizeValid    = _validateSize(size, collateral);
        ebool oiCapsValid  = _validateOICaps(isLong, size);
        ebool rangeValid   = _validateRange(range);

        return FHE.and(FHE.and(
            sizeValid, 
            oiCapsValid), 
            rangeValid
        );
    }

    /// @dev Validate MIN_SIZE <= size <= collateral * MAX_LEVERAGE_X.
    function _validateSize(euint256 size, uint256 collateral) internal returns (ebool) {
        // 
        euint256 min = FHE.asEuint256(MIN_SIZE);
        euint256 max = FHE.asEuint256(collateral * MAX_LEVERAGE_X);

        ebool sizeGTE = FHE.gte(size, min);
        ebool sizeLTE = FHE.lte(size, max);

        return FHE.and(sizeGTE, sizeLTE);
    }

    /// @dev Encrypted OI cap check (true = within caps).
    function _validateOICaps(ebool isLong, euint256 size) internal returns (ebool) {
        // New OIs (encrypted)
        euint256 newLong  = FHE.add(encLongOI,  FHE.select(isLong, size, ZERO));
        euint256 newShort = FHE.add(encShortOI, FHE.select(isLong, ZERO, size));
        euint256 newTotal = FHE.add(newLong, newShort);

        // Caps from plaintext TVL
        euint256 capTotal = FHE.asEuint256((totalLiquidity * OI_CAP_BPS_TOTAL) / BPS_DIVISOR);
        euint256 capLong  = FHE.asEuint256((totalLiquidity * OI_CAP_BPS_LONG)  / BPS_DIVISOR);
        euint256 capShort = FHE.asEuint256((totalLiquidity * OI_CAP_BPS_SHORT) / BPS_DIVISOR);

        ebool longOk  = FHE.lte(newLong,  capLong);
        ebool shortOk = FHE.lte(newShort, capShort);

        ebool totalOk = FHE.lte(newTotal, capTotal);
        ebool sideOk  = FHE.select(isLong, longOk, shortOk);

        return FHE.and(totalOk, sideOk);
    }

    /// @dev Validate (low + BUFFER) < high
    //  entry price is actually *checked* once the position is Open; we just validate correctness here.
    function _validateRange(Range memory range) internal returns (ebool) {
        euint256 buffer = FHE.add(range.low, FHE.asEuint256(PRICE_RANGE_BUFFER));
        return FHE.lt(buffer, range.high);
    }

    function _allowPositionRequest(Position storage p) internal {
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

        FHE.allowThis(p.pendingEquity);
        FHE.allowGlobal(p.pendingEquity);
        FHEHelpers.allowThis(p.entryFunding);
        FHEHelpers.allowThis(p.entryImpact);
    }

    function _allowPositionFinalize(Position storage p) internal {
        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);
        FHEHelpers.allowThis(p.entryFunding);
        FHEHelpers.allowThis(p.entryImpact);
    }

    function closePosition(uint256 positionId) external {
        Position storage p = positions[positionId];
        require(p.owner == msg.sender, "not owner");
        require(p.status == Status.Open, "not open");
        p.cause = CloseCause.UserClose;
        _settlementInitialize(positionId, _markPrice());
    }

    function settlePositions(uint256[] calldata positionIds) external {
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            Position storage p = positions[id];
            if (p.status != Status.AwaitingSettlement) continue;
            _settlementFinalize(id);
        }
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }


}
