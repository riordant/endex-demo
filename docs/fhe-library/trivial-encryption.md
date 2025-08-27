---
title: Trivial Encryption
sidebar_position: 2
description: What is the difference between trivially encrypted numbers and encrypted inputs
---

# Trivial Encryption

In FHE-enabled smart contracts, we often need to perform operations between encrypted values and regular plaintext values. **Trivial encryption** is the operation of converting a plaintext value into an encrypted format that can interact with other encrypted data.

This conversion is done using the `FHE.asEuint` family of functions, which take standard Solidity types and transform them into their encrypted counterparts.

```solidity
uint16 number = 2;
euint16 encrypted_number = FHE.asEuint16(number);
```

## Privacy considerations
**Trivially encrypted values are not confidential** - they are merely a tool to enable interaction between encrypted and non-encrypted types. The original plaintext value remains visible to anyone observing the blockchain, just in a different format.

This is a crucial concept to understand when developing confidential contracts. Any value that is trivially encrypted (e.g. `encrypted_number`) should be treated as public information, even though it uses the same data type as truly encrypted values.

:::important[Important]
`euints` are only confidential when they are formed from encrypted `inEuint` inputs, which are encrypted off-chain. [see more](./data-evaluation.md)
:::

When two trivially-encrypted numbers are combined in an FHE operation, the result is still not confidential, because an observer can keep track of the calculations.

### Example
```solidity
function doSomeCalculations(InEuint16 calldata input) {
    // public
    euint16 number2 = FHE.asEuint16(2);
    euint16 number3 = FHE.asEuint16(3);
    euint16 number5 = FHE.add(number2, number3);

    // confidential
    euint16 encInput = FHE.asEuint16(input);
    euint16 encMul = FHE.mul(encInput, number5);
    
    // public   
    euint16 eFalse = FHE.asEbool(false);           

    // Observer knows that result is encInput, but not what the value is
    euint16 result = FHE.select(eFalse, encMul, encInput);
}
```
