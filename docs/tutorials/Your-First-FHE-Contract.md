---
title: Your First FHE Contract
sidebar_position: 3
---

# Your First FHE Contract

Let's take a look at a simple contract that uses FHE to encrypt a counter, and break it down into its components.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {FHE, euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract SimpleCounter {
    address owner;

    euint64 counter;
    euint64 delta;
    euint64 lastDecryptedCounter;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can access that function");
        _;
    }

    constructor(uint64 initial_value) {
        owner = msg.sender;
        counter = FHE.asEuint64(initial_value);
        FHE.allowThis(counter);

        // Encrypt the value 1 only once instead of every value change
        delta = FHE.asEuint64(1);
        FHE.allowThis(delta);
    }

    function increment_counter() external onlyOwner {
        counter = FHE.add(counter, delta);
        FHE.allowThis(counter);
    }

    function decrement_counter() external onlyOwner {
        counter = FHE.sub(counter, delta);
        FHE.allowThis(counter);
    }

    function reset_counter(InEuint64 calldata value) external onlyOwner {
        counter = FHE.asEuint64(value);
        FHE.allowThis(counter);
    }

    function decrypt_counter() external onlyOwner {
        lastDecryptedCounter = counter;
        FHE.decrypt(lastDecryptedCounter);
    }

    function get_counter_value() external view returns(uint256) {
        (uint256 value, bool decrypted) = FHE.getDecryptResultSafe(lastDecryptedCounter);
        if (!decrypted)
            revert("Value is not ready");

        return value;
    }

    function get_encrypted_counter_value() external view returns(euint64) {
       return counter;
    }
    
}
```

To start using FHE, we need to import the FHE library.
In this example, we're importing the types `euint64` and `InEuint64` from the [FHE library](/docs/devdocs/solidity-api/FHE).


```solidity
import {FHE, euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
```
We want to keep the counter encrypted at all times, so we'll use the `euint64` type.

Next, we define some state variables for the contract:
```solidity
    euint64 counter;
    euint64 delta;
    euint64 lastDecryptedCounter;
```

In the constructor, we initialize the `counter` and `delta` variables.
We encrypt the `delta` here to avoid calculating the same encrypted value every time we increment or decrement the counter.

```solidity
    counter = FHE.asEuint64(initial_value);
    delta = FHE.asEuint64(1);
```

:::note
We wanted the example contract to be as simple as possible, so readers can plug-and-play it into their preferred environment.
There are some privacy improvements that could be made to this contract.

<details>
<summary> Trivial Encryption </summary>

When we initialize the `delta` and `counter` variables, we use **trivial encryption**.
**Trivial encryption** produces a ciphertext from a public value, but this
variable, even though represented as a ciphertext handle, is not really confidential because everyone can see what is the
plaintext value that went into it.

To make it completely private, we need to initialize these variables with an InEuint from the calldata.
More about trivial encryption [here](/docs/devdocs/fhe-library/trivial-encryption.md).
</details>
:::

For every encrypted variable, we need to call `FHE.allowThis()` to allow the contract to access it.
**Allowing access to encrypted variables** is an important concept in FHE-enabled contracts.
Without it, the contract could not continue to use this encrypted variable in future transactions.
You can read more about this in the [ACL Mechanism](/docs/devdocs/fhe-library/acl-mechanism) page.
```solidity
    FHE.allowThis(counter);
    FHE.allowThis(delta);
```

In the `increment_counter` and `decrement_counter` functions, we use the `FHE.add` and `FHE.sub` functions to increment and decrement the counter, respectively.
And we also call `FHE.allowThis()` to allow the contract to access the new counter value.

```solidity
    counter = FHE.add(counter, delta);
    FHE.allowThis(counter);
```
In the `reset_counter` function, we receive an `InEuint64` value, which is a type that represents an encrypted value that can be used to reset the counter.  
This value is an encrypted value that we created using Cofhejs (read more about it [here](/docs/devdocs/cofhejs/encryption-operations)).

Now, let's take a look at the `decrypt_counter` and `get_counter_value` functions.  
The `decrypt_counter` function creates a new decrypt request for the counter.  
Since we want to allow users to call `get_counter_value` function at any given time, we need store the handle in the `lastDecryptedCounter` variable.  
The result will be valid until the next `decrypt_counter` call.

In the `get_counter_value` function, we use the `FHE.getDecryptResultSafe` function to get the decrypted value of the counter.  
Since the decryption is asynchronous, we need to check if the result is ready by checking the `decrypted` boolean.   
If the result is not ready, we revert the transaction with an error message.

```solidity
    function get_counter_value() external view returns(uint256) {
        (uint256 value, bool decrypted) = FHE.getDecryptResultSafe(lastDecryptedCounter);
        if (!decrypted)
            revert("Value is not ready");

        return value;
    }
```

In this contract, only the owner can request for a decryption. Once requested, everyone can read the counter's value at any given time.  
The owner needs to send a transaction to the `decrypt_counter`.  

What if we want to allow the owner to privately read the value without sending a transaction that calls `FHE.decrypt`, exposing the counter to everyone?

For that, we need to add call for `FHE.allow(counter, owner)` or `FHE.allowSender(counter)`  every time that we change the counter's value.
This will allow the owner to read the encrypted counter's value using the `get_encrypted_counter_value` function and decrypt it using Cofhejs.

```solidity
    function increment_counter() external onlyOwner {
        counter = FHE.add(counter, delta);
        FHE.allowThis(counter);
        FHE.allowSender(counter);
    }

    function get_encrypted_counter_value() external view returns(euint64) {
       return counter;
    }
```
In the [next section](/docs/devdocs/cofhejs#end-to-end-example) we will see how to use Cofhejs to privately decrypt this encrypted contract variable.

<span style={{color: "orange", fontStyle: "italic"}}>Exercise:</span> Try to modify the contract to allow the owner to read the counter's value without sending a transaction every time, you will need it in order to make the Cofhejs example work.
