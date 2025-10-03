// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "../Endex.sol";

// Contract for testing purposes.
// Makes global encrypted vars available to be decrypted via cofhe.unseal in tests.
// also exposes functions that should be kept internal, but we need exposed for tests.
contract EndexHarness is Endex {
    constructor(IERC20 _usdc, IAggregatorV3 _feed) Endex(_usdc, _feed) {
        _allowGlobalMock();
    }

    function setFundingRateFromSkew() public {
        _setFundingRateFromSkew();
        _allowGlobalMock();
    }

    function updateFunding() public {
        _updateFunding();
        _allowGlobalMock();
    }

    function openPositionRequest(
        InEbool calldata isLong_,
        InEuint256 calldata size_,
        InRange calldata entryPriceRange_,
        uint256 collateral
    ) external override {
        _openPositionRequest(
            isLong_,
            size_,
            entryPriceRange_,
            collateral
        );
        _allowGlobalMock();
    }

    function _openPositionFinalize(
        Position storage p,
        uint256 price
    ) internal override(EndexBase, EndexTrading) {
        __openPositionFinalize(
            p,
            price
        );
        _allowGlobalMock();
        FHEHelpers.allowGlobal(p.entryFunding);
        FHEHelpers.allowGlobal(p.entryImpact);
    }

    function _allowGlobalMock() internal {
        FHEHelpers.allowGlobal(fundingRatePerSecond);
        FHEHelpers.allowGlobal(cumFundingLong);
        FHEHelpers.allowGlobal(cumFundingShort);
    }
}
