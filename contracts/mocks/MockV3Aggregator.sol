// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract MockV3Aggregator {
    int256 private _price;
    uint8 private _decimals;
    uint80 private _roundId;

    constructor(uint8 _decimals_, int256 _price_) {
        _decimals = _decimals_;
        _price = _price_;
        _roundId = 1;
    }

    function updateAnswer(int256 _newPrice) external {
        _price = _newPrice;
        _roundId++;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external pure returns (string memory) {
        return "Mock ETH/USD Price Feed";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 _id) external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (_id, _price, block.timestamp, block.timestamp, _id);
    }

    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (_roundId, _price, block.timestamp, block.timestamp, _roundId);
    }
}
