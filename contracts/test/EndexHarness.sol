// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "../Endex.sol";

// Contract for testing purposes.
// Makes global encrypted vars available to be decrypted via cofhe.unseal in tests.
// also exposes functions that should be kept internal, but we need exposed for tests.
contract EndexHarness is Endex {
    constructor(IERC20 _usdc, IAggregatorV3 _ethUsdFeed) Endex(_usdc, _ethUsdFeed) {
        _allowFunding_Global();
    }

    function setFundingRateFromSkew() public {
        _setFundingRateFromSkew();
        _allowFunding_Global();
    }

    function pokeFunding() public {
        _pokeFunding();
        _allowFunding_Global();
    }

    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice
    ) external override {
        _openPosition(
            isLong,
            size_,
            collateral,
            stopLossPrice,
            takeProfitPrice
        );
        _allowFunding_Global();
        Position storage position = positions[nextPositionId-1];
        _allowEint256_Global(position.entryFundingX18);
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
}
