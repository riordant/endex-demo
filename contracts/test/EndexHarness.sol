// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "../Endex.sol";

// Contract for testing purposes.
// Makes global encrypted vars available to be decrypted via cofhe.unseal in tests.
// also exposes functions that should be kept internal, but we need exposed for tests.
contract EndexHarness is Endex {
    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed, address keeper) Endex(_usdc, _ethUsdFeed, keeper) {
        _allowFunding_Global_();
    }

    function setFundingRateFromSkew() public {
        _setFundingRateFromSkew();
        _allowFunding_Global_();
    }

    function pokeFunding() public {
        _pokeFunding();
        _allowFunding_Global_();
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
        _allowFunding_Global_();
        Position storage position = positions[nextPositionId-1];
        _allowEint256_Global(position.entryFunding);
    }

    function _allowFunding_Global_() internal {
        _allowEint256_Global_(fundingRatePerSecX18);
        _allowEint256_Global_(cumFundingLongX18);
        _allowEint256_Global_(cumFundingShortX18);
        FHE.allowGlobal(encLongOI);
        FHE.allowGlobal(encShortOI);
    }

    function _allowEint256_Global_(eint256 storage a) internal {
        FHE.allowGlobal(a.sign);
        FHE.allowGlobal(a.val);
    }
}
