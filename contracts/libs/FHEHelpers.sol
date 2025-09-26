// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

struct eint256 {
    // sign = true  => non-negative
    // sign = false => negative
    ebool    sign;
    euint256 val;   // magnitude >= 0 (X18 where noted)
}

library FHEHelpers {
    function _zero() internal returns(euint256) {
        return FHE.asEuint256(0);
    }

    function _one() internal returns(euint256) {
        return FHE.asEuint256(1);
    }

    function _two() internal returns(euint256) {
        return FHE.asEuint256(2);
    }

    // ---------- Encrypted-boolean helpers (no plain bool branching) ----------
    // r = r (+/-) (bSign ? +bVal : -bVal)
    function _encAddSigned(eint256 storage r, ebool bSign, euint256 bVal) internal {
        (ebool s, euint256 v) = _encAddSignedPair(r.sign, r.val, bSign, bVal);
        r.sign = s;
        r.val  = v;
    }
    
    // a - b = a + (-b)
    function _encSubSigned(eint256 memory a, eint256 memory b) internal returns (eint256 memory c) {
        ebool negBsign = _ebNot(b.sign);
        (c.sign, c.val) = _encAddSignedPair(a.sign, a.val, negBsign, b.val);
    }
    
    // Generic signed add on pairs (returns new sign,val)
    function _encAddSignedPair(
        ebool aSign, euint256 aVal,
        ebool bSign, euint256 bVal
    ) internal returns (ebool outSign, euint256 outVal) {
        euint256 sum = FHE.add(aVal, bVal);
        ebool    aGeB = FHE.gte(aVal, bVal);
        euint256 diff = FHE.sub(
            FHE.select(aGeB, aVal, bVal),
            FHE.select(aGeB, bVal, aVal)
        );
    
        // sameSign = (aSign == bSign)
        ebool sameSign = _ebEqual(aSign, bSign);
    
        // val = same ? sum : diff
        outVal  = FHE.select(sameSign, sum, diff);
        // sign = same ? aSign : (aGeB ? aSign : bSign)
        outSign = _ebSelect(sameSign, aSign, _ebSelect(aGeB, aSign, bSign));
    }

    // Encrypted true/false
    // Map ebool <-> euint256 {false=>0, true=>1}
    function _ebToUint(ebool b) internal returns (euint256) {
        return FHE.select(b, FHE.asEuint256(1), FHE.asEuint256(0));
    }
    function _uintToEb(euint256 u) internal returns (ebool) {
        // u >= 1 => true; u == 0 => false
        return FHE.gte(u, FHE.asEuint256(1));
    }
    
    // NOT(b) using select+compare only
    function _ebNot(ebool b) internal returns (ebool) {
        // if b then 0 else 1
        euint256 inv = FHE.select(b, FHE.asEuint256(0), FHE.asEuint256(1));
        return FHE.gte(inv, FHE.asEuint256(1));
    }
    
    // (a == b) without eq/xor: diff = |a-b| on {0,1}; diff<1 => equal
    function _ebEqual(ebool a, ebool b) internal returns (ebool) {
        euint256 ua  = _ebToUint(a);
        euint256 ub  = _ebToUint(b);
        ebool    ge  = FHE.gte(ua, ub);
        euint256 diff = FHE.sub(
            FHE.select(ge, ua, ub),
            FHE.select(ge, ub, ua)
        );
        return FHE.lt(diff, FHE.asEuint256(1));
    }
    
    // Select between two ebools with encrypted condition
    function _ebSelect(ebool cond, ebool x, ebool y) internal returns (ebool) {
        euint256 ux = _ebToUint(x);
        euint256 uy = _ebToUint(y);
        euint256 u  = FHE.select(cond, ux, uy);
        return _uintToEb(u);
    }

    // allow eint256 (sign + val)
    function _allowEint256(eint256 storage a) internal {
        FHE.allowThis(a.sign);
        FHE.allowThis(a.val);
    }

    function _selectEint(ebool cond, eint256 memory a, eint256 memory b) internal returns(eint256 memory r) {
        r.sign = FHE.select(cond, a.sign, b.sign);
        r.val = FHE.select(cond, a.val, b.val);
    }
}
