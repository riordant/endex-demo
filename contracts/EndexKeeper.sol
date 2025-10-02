// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "./EndexBase.sol";

abstract contract EndexKeeper is EndexBase {
    using FHEHelpers for *;
    using SafeERC20 for IERC20;

    function process(uint256[] calldata positionIds) external {
        uint256 price = _markPrice();

        // Keep funding fresh for equity calc
        _pokeFunding();

        for (uint256 i = 0; i < positionIds.length; i++) {
            uint id = positionIds[i];
            Position storage p = positions[id];
            Validity storage v = p.validity;

            // Requested: user requested to open a new position. check validity of parameters on the coprocessor.
            if(p.status == Status.Requested) {
                (bool requestValid, bool ready) = FHE.getDecryptResultSafe(v.requestValid);
                if(!ready) continue;
                
                // openPosition request check passed: move to Pending.
                if(requestValid) {
                    // continue to pending status
                    p.status = Status.Pending;
                } else {
                    // invalid position; set removed == true, return funds to user 
                    // NOTE: naive; in a prod version we will enforce a penalty as we will assume this case is due to adversarial action on behalf of the user.
                    _returnUserFunds(p, v);
                }
            }
            
            // Pending: requested open position passed parameter checks. start validating position against encrypted entry price.
            if(p.status == Status.Pending) {
                // ignore 'ready' here; this allows the flow to check entry price immediately when coming from Requested state,
                // and set pending as done in the next call should the entry price be in-range.
                (bool pendingDone,) = FHE.getDecryptResultSafe(v.pendingDone);
                
                // entry price range checks passed; move to Open.
                if(pendingDone) {
                    _openPositionFinalize(p, price);
                    p.status = Status.Open;
                } else {
                    _checkEntryPrice(p, v, price);
                }
            }
            
            // Open: Mark price in-range, begin liquidation checks. 
            if(p.status == Status.Open) {
                (bool toBeLiquidated, bool ready) = FHE.getDecryptResultSafe(v.toBeLiquidated);
                if(!ready) continue;
                
                if(!toBeLiquidated) {
                    _liquidationCheck(id, price);
                } else {
                    _liquidationFinalize(id);
                }
            }

            // AwaitingSettlement: Position has reached the conditions for closed/liquidated. Await async call from CoFHE to settle.
            if(p.status == Status.AwaitingSettlement) {
                bool settled = _settlementFinalize(id);
                if(settled) {
                    p.status = (p.cause == CloseCause.Liquidation) ? Status.Liquidated : Status.Closed;
                }
            }

            // Do nothing in cases of status == Liquidated || Closed (no more actions to perform for this position).
        }
    }

    function _returnUserFunds(Position storage p, Validity storage v) private {
        if(!v.removed) { 
            pendingCollateral -= p.collateral;
            underlying.safeTransfer(p.owner, p.collateral);
            v.removed = true;
        }
    }

    function _checkEntryPrice(Position storage p, Validity storage v, uint256 price_) private {
        Range storage entryRange = p.entryPriceRange;

        euint256 price = FHE.asEuint256(price_);
        ebool markGTE = FHE.gte(price, entryRange.low);
        ebool markLTE = FHE.lte(price, entryRange.high);
        v.pendingDone = FHE.and(markGTE, markLTE);

        // decrypt and make pendingDone available to all users
        FHE.allowGlobal(v.pendingDone);
        FHE.decrypt(v.pendingDone);
    }
}
