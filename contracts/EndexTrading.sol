// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexTrading is EndexBase {
    using FHEHelpers for *;
    using SafeERC20 for IERC20;

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        bool isLong,
        euint256 size,
        uint256 collateral,
        uint256 entryPrice
    );

    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral
    ) external virtual {
        _openPosition(
            isLong,
            size_,
            collateral
        );
    }

    function _openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral
    ) internal {
        // Accrue funding before opening (with previous rate)
        _pokeFunding();

        // Price & collateral checks
        (, int256 price,,,) = ethUsdFeed.latestRoundData();
        require(price > 0, "price");
        require(collateral > 0, "collateral=0");

        // Clamp encrypted requested size to [MIN_NOTIONAL_USDC, collateral * MAX_LEVERAGE_X]
        euint256 size = _clampEncryptedSize(size_, collateral);

        // Pull collateral
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        usdcBalance += collateral;

        uint256 id = nextPositionId++;

        // --- Entry price impact buckets (encrypted) BEFORE updating OI ---
        (euint256 impGainX18, euint256 impLossX18) =
            _encImpactEntryBucketsAtOpenX18(isLong, size, uint256(price));

        // Snapshot entry funding (encrypted signed)
        eint256 memory entryFunding = isLong ? cumFundingLongX18 : cumFundingShortX18;

        positions[id] = Position({
            owner: msg.sender,
            positionId: id,
            isLong: isLong,
            size: size,
            collateral: collateral,
            entryPrice: uint256(price),
            settlementPrice: 0,
            status: Status.Open,
            cause: CloseCause.UserClose, // default
            entryFundingX18: entryFunding,
            pendingLiqFlagEnc: FHEHelpers._zero(),
            pendingLiqCheckPrice: 0,
            liqCheckPending: false,
            encImpactEntryGainX18: impGainX18,
            encImpactEntryLossX18: impLossX18,
            pendingEquityX18: FHEHelpers._zero()
        });

        Position storage p = positions[id];

        // Update encrypted OI aggregates (AFTER recording entry impact based on pre-trade OI)
        if (isLong) {
            encLongOI = FHE.add(encLongOI, size);
        } else {
            encShortOI = FHE.add(encShortOI, size);
        }

        // Update funding rate for future accruals
        _setFundingRateFromSkew();

        // Permissions for ciphertexts
        FHE.allowSender(p.size);
        FHE.allowGlobal(p.pendingLiqFlagEnc);

        FHE.allowThis(p.size);
        FHE.allowThis(p.pendingLiqFlagEnc);
        FHE.allowThis(p.encImpactEntryGainX18);
        FHE.allowThis(p.encImpactEntryLossX18);
        FHE.allowThis(p.pendingEquityX18);

        FHE.allowThis(encLongOI);
        FHE.allowThis(encShortOI);

        emit PositionOpened(id, msg.sender, isLong, size, collateral, uint256(price));
    }

    /// @dev Clamp encrypted requested size into [MIN_NOTIONAL_USDC, collateral * MAX_LEVERAGE_X].
    function _clampEncryptedSize(InEuint256 calldata size_, uint256 collateral) internal returns (euint256) {
        euint256 _size  = FHE.asEuint256(size_);
        euint256 minEnc = FHE.asEuint256(MIN_NOTIONAL_USDC);
        euint256 maxEnc = FHE.asEuint256(collateral * MAX_LEVERAGE_X);

        // size1 = max(_size, MIN_NOTIONAL_USDC)
        euint256 size1  = FHE.select(FHE.lt(_size, minEnc), minEnc, _size);
        // size  = min(size1, collateral * MAX_LEVERAGE_X)
        euint256 size   = FHE.select(FHE.gt(size1, maxEnc), maxEnc, size1);

        return size;
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
