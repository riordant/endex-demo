---
title: Adding FHE to an Existing Contract
sidebar_position: 3
---

# Adding FHE to an Existing Contract

Lets start with an existing contract, and walk through the steps to migrate the contract to CoFHE.

The contract is very simple voting contract

```solidity
// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (token/ERC20/ERC20.sol)

pragma solidity ^0.8.25;

contract VotingExample {
    struct Option {
        string name;
        uint64 votes;
    }

    struct Proposal {
        string name;
        uint256 deadline;
        Option[] options;
        mapping(address => bool) hasVoted;
        bool exists;
        uint8 winner;
    }

    address public owner;
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    event ProposalCreated(
        uint256 indexed proposalId,
        string name,
        uint256 deadline
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        uint256 optionIndex
    );

    error NotOwner();
    error InvalidOptionCount();
    error ProposalNotFound();
    error DeadlineExpired();
    error AlreadyVoted();
    error InvalidOptionIndex();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function createProposal(
        string memory _name,
        string[] memory _options,
        uint256 _deadline
    ) external onlyOwner returns (uint256) {
        if (_options.length < 2 || _options.length > 4)
            revert InvalidOptionCount();

        uint256 proposalId = proposalCount++;
        Proposal storage proposal = proposals[proposalId];

        proposal.name = _name;
        proposal.deadline = _deadline;
        proposal.exists = true;

        for (uint i = 0; i < _options.length; i++) {
            proposal.options.push(Option({name: _options[i], votes: 0}));
        }

        emit ProposalCreated(proposalId, _name, _deadline);
        return proposalId;
    }

    function vote(uint256 _proposalId, uint256 _optionIndex) external {
        Proposal storage proposal = proposals[_proposalId];

        if (!proposal.exists) revert ProposalNotFound();
        if (block.timestamp >= proposal.deadline) revert DeadlineExpired();
        if (proposal.hasVoted[msg.sender]) revert AlreadyVoted();
        if (_optionIndex >= proposal.options.length)
            revert InvalidOptionIndex();

        proposal.options[_optionIndex].votes++;
        proposal.hasVoted[msg.sender] = true;

        emit VoteCast(_proposalId, msg.sender, _optionIndex);
    }

    function getProposal(
        uint256 _proposalId
    )
        external
        view
        returns (
            string memory name,
            uint256 deadline,
            Option[] memory options,
            bool exists
        )
    {
        Proposal storage proposal = proposals[_proposalId];
        return (
            proposal.name,
            proposal.deadline,
            proposal.options,
            proposal.exists
        );
    }

    function hasVoted(
        uint256 _proposalId,
        address _voter
    ) external view returns (bool) {
        return proposals[_proposalId].hasVoted[_voter];
    }
}
```

In this contract, the owner can create a proposal with anywhere from 2-4 possible voting options. Users can then vote on this proposal by the deadline, at which point the proposal can be closed, and the result revealed.

Unfortunately, the contract is completely public, and the vote tallies can be observed during the voting period. We will update this contract to interact with CoFHE, and use FHE encrypted variables to store the votes until the result is revealed.

We will pay special attention to the following updates that need to be made:

1. **Constant time computation.**
2. **Handling the `if/else` case.**
3. **Handling the `require` case.**
4. **Revealing the result with `FHE.decrypt`.**

## Migrating the Contract

### 1. Import `FHE.sol`

The first thing that we need to do is import `FHE.sol` from the `cofhe-contracts` repo. This package allows smart contracts to start using FHE operations and encrypted variables.

```solidity
pragma solidity ^0.8.25;

// diff-add
import {FHE, euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract VotingExample {
```

### 2. Encrypt the vote counters with `euint64`

The amount of votes cast for each option needs to be encrypted, so we can switch the variable type from a `uint64` to an `euint64` (`euint64` is included in the `FHE.sol` import). The vote counts will be represented by a `ctHash` which acts as a handle and pointer to the encrypted number of votes.

```solidity
    struct Option {
        string name;
        // diff-remove
        uint64 votes;
        // diff-add
        euint64 votes;
    }
```

### 3. Initialize the `euint64` vote counts

Now that the votes type has changed, it must be initialized by performing a `trivialEncrypt` of the starting value:

```solidity
  function createProposal(
      string memory _name,
      string[] memory _options,
      uint256 _deadline
  ) external onlyOwner returns (uint256) {
      if (_options.length < 2 || _options.length > 4)
          revert InvalidOptionCount();

      uint256 proposalId = proposalCount++;
      Proposal storage proposal = proposals[proposalId];

      proposal.name = _name;
      proposal.deadline = _deadline;
      proposal.exists = true;

      for (uint i = 0; i < _options.length; i++) {
          // diff-remove
          proposal.options.push(Option({name: _options[i], votes: 0}));
          // diff-add
          proposal.options.push(
            //diff-add
              Option({name: _options[i], votes: FHE.asEuint64(0)})
          //diff-add
          );
      }

      emit ProposalCreated(proposalId, _name, _deadline);
      return proposalId;
  }
```

This will work, but it may make sense to prepare the trivially encrypted values in the constructor rather than in each transaction to save on gas and the number of FHE operations being execute. Lets see how that would look:

```solidity
contract VotingExample {
    ...

    // diff-add
    euint64 private EUINT64_ZERO;
    // diff-add
    euint64 private EUINT64_ONE;

    constructor() {
        owner = msg.sender;
        // diff-add
        EUINT64_ZERO = FHE.asEuint64(0);
        // diff-add
        EUINT64_ONE = FHE.asEuint64(1);
    }

    function createProposal(
        string memory _name,
        string[] memory _options,
        uint256 _deadline
    ) external onlyOwner returns (uint256) {

        ...

        for (uint i = 0; i < _options.length; i++) {
            proposal.options.push(
                // diff-remove
                Option({name: _options[i], votes: FHE.asEuint64(0)})
                // diff-add
                Option({name: _options[i], votes: EUINT64_ZERO})
            );
        }

       ...
    }


```

### 4. Handle user votes with `InEuint8`

We now need to handle the user's vote casting. The first thing that we need to do is hide which option the user is voting for. We can do this by replacing the `vote` function parameter `uint256 _optionIndex` with `InEuint8 memory _optionIndex`. `InEuint8` is an encrypted input type. We then need to convert the `InEuint8` to an `euint8` for use in computation.

> NOTE:<br/>Encrypting inputs requires the use of [**cofhejs**](/docs/devdocs/cofhejs/index.md).<br/> Read more about [**encrypted inputs**](../cofhejs/encryption-operations.md).

```solidity
    // diff-remove
    function vote(uint256 _proposalId, uint256 _optionIndex) external {
    // diff-add
    function vote(uint256 _proposalId, InEuint8 memory _optionIndex) external {
    // diff-add
        euint8 optionIndex = FHE.asEuint8(_optionIndex);
```

### 5. Special case: **Constant time Computation**

In order to preserve the confidentiality of the user's vote, we must make sure that we aren't leaking any information about the user's choice. If we only updated the voting option that the user has selected, then a user's vote could be deduced by simply watching which vote counter changes. Therefore, we must update _all_ the vote counters to hide the user's true vote:

```solidity
function vote(uint256 _proposalId, InEuint8 memory _optionIndex) external {
    euint8 optionIndex = FHE.asEuint8(_optionIndex);
    Proposal storage proposal = proposals[_proposalId];

    if (!proposal.exists) revert ProposalNotFound();
    if (block.timestamp >= proposal.deadline) revert DeadlineExpired();
    if (proposal.hasVoted[msg.sender]) revert AlreadyVoted();
    if (_optionIndex >= proposal.options.length)
        revert InvalidOptionIndex();

    // diff-remove
    proposal.options[_optionIndex].votes++;
    // diff-add
    for (uint8 i = 0; i < proposal.options.length; i++) {
        // diff-add
        proposal.options[i].votes = FHE.add(
            // diff-add
            proposal.options[i].votes,
            // diff-add
            FHE.select(
                // diff-add
                _optionIndex.eq(FHE.asEuint8(i)),
                // diff-add
                EUINT64_ONE,
                // diff-add
                EUINT64_ZERO
            // diff-add
           )
        // diff-add
        );
    // diff-add
    }
    proposal.hasVoted[msg.sender] = true;

    emit VoteCast(_proposalId, msg.sender, _optionIndex);
}
```

Lets break down how this works:

- We iterate through each of the proposal options.
- We _always_ perform an `FHE.add` on every options' vote count, this means that every options' vote count will change any time a user votes.
- We only want to increment the user's selected choice, so we use `FHE.select`.
- The api for select is `FHE.select(conditional, ifTrue, ifFalse)`.
- Without the FHE syntax, the logic is as follows:

```solidity
proposal.options[i].votes =
    proposal.options[i].votes + _optionIndex == i ? 1 : 0;
```

### 6. Special case: **`if/else`**

Branching based on encrypted variables is not allowed, so there is one more change to make to the `vote` function, which is to remove the **`if/else`** branch that relies on `_optionIndex`.

> NOTE: **`require`** statements are also not allowed when working with encrypted variables for the same reason as above.

```solidity
    // diff-remove
    if (_optionIndex >= proposal.options.length)
        // diff-remove
        revert InvalidOptionIndex();
```

> NOTE: It is important to _never_ use an encrypted variable as part of a if/else branch, since the encrypted variable is always truthy. Instead, use `FHE.select` to replace the value with 0.

### 7. Update `VoteCast` event

Currently the `VoteCast` event emits a uint256 optionIndex. Now that the user's vote is an encrypted variable (`euint8`), we need to update the event to emit the user's encrypted input:

```solidity
event VoteCast(
    uint256 indexed proposalId,
    address indexed voter,
    // diff-remove
    uint256 optionIndex
    // diff-add
    euint8 optionIndex
);
```

And its invocation:

```solidity
        // diff-remove
        emit VoteCast(_proposalId, msg.sender, _optionIndex);
        // diff-add
        emit VoteCast(_proposalId, msg.sender, optionIndex);
```

This event will be emitted with the encrypted `euint8 optionIndex`, this is important as in the future the FHE block explorer will be able to decrypt these variables and show the true event log, but only if we make one more change:

### 8. Granting access with `FHE.allow`

By default, access and computation on an encrypted variable is blocked, and trying to use a variable before access has been granted will cause AccessControlList.sol (ACL) to revert with an `ACLNotAllowed` error. Access is granted using `FHE.allow` (and its variants `FHE.allowSender`, `FHE.allowThis`, and `FHE.allowGlobal`). After access is granted, the encrypted variable may be used in a computation, or decrypted by any of the authorized users or contracts.

**`FHE.allow` variants**

- `FHE.allow(ctHash, address)` - grants access to `address`. `ctHash` is any encrypted variable like `euint64` or `ebool`.
- `FHE.allowSender(ctHash)` - grants access to `msg.sender`.
- `FHE.allowThis(ctHash)` - grants access to the executing contract (`address(this)`).
- `FHE.allowGlobal(ctHash)` - grants access to everyone, useful for things like an encrypted totalSupply variable, which everyone should have access to.

```solidity
function vote(uint256 _proposalId, InEuint8 memory _optionIndex) external {
    euint8 optionIndex = FHE.asEuint8(_optionIndex);
    Proposal storage proposal = proposals[_proposalId];

    if (!proposal.exists) revert ProposalNotFound();
    if (block.timestamp >= proposal.deadline) revert DeadlineExpired();
    if (proposal.hasVoted[msg.sender]) revert AlreadyVoted();

    for (uint8 i = 0; i < proposal.options.length; i++) {
        proposal.options[i].votes = FHE.add(
            proposal.options[i].votes,
            FHE.select(
                optionIndex.eq(FHE.asEuint8(i)),
                FHE.asEuint64(1),
                FHE.asEuint64(0)
            )
        );
        // Grant this contract access to each vote count
        // Without this, FHE.add(options[i].votes, ...) would revert
        // diff-add
        FHE.allowThis(proposal.options[i].votes);
    }
    proposal.hasVoted[msg.sender] = true;

    // Grant msg.sender access to their votingIndex
    // Without this, the msg.sender would not be able to see their vote in the explorer (coming soon)
    // diff-add
    FHE.allowSender(optionIndex);
    emit VoteCast(_proposalId, msg.sender, optionIndex);
}
```

> NOTE: It is critical to ensure that `FHE.allowThis` is used on encrypted variables that need to be used later in the contract's lifecycle. Contracts must have access to variables in order to perform FHE operations on those variables.

### 9. Finalize the voting with `FHE.decrypt`

Because the votes are encrypted for the lifetime of the proposal, after the proposal has ended, we need to decrypt the results and reveal the winner. Lets start by adding a `finalizeVote` function:

```solidity
// diff-add
function finalizeVote(uint256 _proposalId) external {
    // diff-add
    if (msg.sender != owner) revert NotOwner();
    // diff-add

    // diff-add
    Proposal storage proposal = proposals[_proposalId];
    // diff-add
    if (!proposal.exists) revert ProposalNotFound();
    // diff-add
    if (block.timestamp < proposal.deadline) revert DeadlineNotReached();
    // diff-add

    // diff-add
    for (uint8 i = 0; i < proposal.options.length; i++) {
        // diff-add
        FHE.decrypt(proposal.options[i].votes);
    // diff-add
    }
// diff-add
}
```

As you can see, we perform a `FHE.decrypt` request on each of the proposal's options' vote counts. These decryption results are performed asynchronously, and the decrypted results are posted to the chain as soon as they are available.

### 10. Checking the results with `FHE.getDecryptResultSafe`

Finally, we can update our `getProposal` function to check the final state of the proposal:

```solidity
function getProposal(
    uint256 _proposalId
)
    external
    view
    returns (
        string memory name,
        uint256 deadline,
        // diff-remove
        Option[] memory options,
        // diff-remove
        bool exists
        // diff-add
        bool exists,
        // diff-add
        string[] memory options,
        // diff-add
        uint256[] memory votes,
        // diff-add
        bool finalized,
        // diff-add
        uint8 winner
    )
{
    Proposal storage proposal = proposals[_proposalId];

    // diff-remove
    return (
        // diff-remove
        proposal.name,
        // diff-remove
        proposal.deadline,
        // diff-remove
        proposal.options,
        // diff-remove
        proposal.exists
    // diff-remove
    );

    // Plaintext values can be assigned directly
    // diff-add
    name = proposal.name;
    // diff-add
    deadline = proposal.deadline;
    // diff-add
    exists = proposal.exists;
    // diff-add

    // diff-add
    options = new string[](proposal.options.length);
    // diff-add
    for (uint8 i = 0; i < proposal.options.length; i++) {
        // diff-add
        options[i] = proposal.options[i].name;
    // diff-add
    }
    // diff-add

    // Fetch the decrypted results with `FHE.getDecryptResultSafe`.
    // If any of the results have not yet been decrypted, set `finalized` to false.
    // Store the decrypted result counts in the `votes` list to be returned.
    // diff-add
    votes = new uint64[](proposal.options.length);
    // diff-add
    finalized = true;
    // diff-add
    for (uint8 i = 0; i < proposal.options.length; i++) {
        // diff-add
        (uint256 result, bool decrypted) = FHE.getDecryptResultSafe(
            // diff-add
            proposal.options[i].votes
        // diff-add
        );
        // diff-add
        votes[i] = decrypted ? result : 0;
        // diff-add
        if (!decrypted) finalized = false;
    // diff-add
    }
    // diff-add

    // If all votes have been decrypted, determine the winning option.
    // diff-add
    if (finalized) {
        // diff-add
        uint256 maxVotes = 0;
        // diff-add
        winner = 0;
        // diff-add
        for (uint8 i = 0; i < proposal.options.length; i++) {
            // diff-add
            if (proposal.options[i].votes > maxVotes) {
                // diff-add
                maxVotes = proposal.options[i].votes;
                // diff-add
                winner = i;
            // diff-add
            }
        // diff-add
        }
    // diff-add
    }
}
```

In this block you can see a few changes. The first is that we have split `options` and `votes` from the `getProposal` return type, which allows us to better handle the decryption results.

We use `FHE.getDecryptResultSafe` to fetch the decryption result of each of the vote counts, which returns the result as well as a flag indicating whether the decryption has posted.

Once all the decryptions have posted, the `finalized` flag will update to be `true`, and the `winner` determined based on the vote counts.

### Conclusions

In this tutorial, we walked through migrating a simple voting contract to use CoFHE. The key changes were:

1. Changing the vote counts from plain `uint64` to encrypted values using `euint64`
2. Modifying the voting function to use encrypted addition instead of plain addition
3. Updating the getter function to handle decryption of results safely

The resulting contract provides the same functionality as the original, but with the added privacy benefit that individual votes are not visible on-chain until the final tally is decrypted. This demonstrates how CoFHE can be used to add privacy to existing contracts with minimal changes to the core logic.

### Final `FHEVotingExample.sol`

```solidity
// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (token/ERC20/ERC20.sol)

pragma solidity ^0.8.25;

import {FHE, euint64, InEuint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract FHEVotingExample {
    struct Option {
        string name;
        euint64 votes;
    }

    struct Proposal {
        string name;
        uint256 deadline;
        Option[] options;
        mapping(address => bool) hasVoted;
        bool exists;
        uint8 winner;
    }

    address public owner;
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    euint64 private EUINT64_ZERO;
    euint64 private EUINT64_ONE;

    event ProposalCreated(
        uint256 indexed proposalId,
        string name,
        uint256 deadline
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        uint256 optionIndex
    );

    error NotOwner();
    error InvalidOptionCount();
    error ProposalNotFound();
    error DeadlineExpired();
    error AlreadyVoted();
    error InvalidOptionIndex();
    error DeadlineNotReached();

    constructor() {
        owner = msg.sender;
        EUINT64_ZERO = FHE.asEuint64(0);
        EUINT64_ONE = FHE.asEuint64(1);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function createProposal(
        string memory _name,
        string[] memory _options,
        uint256 _deadline
    ) external onlyOwner returns (uint256) {
        if (_options.length < 2 || _options.length > 4)
            revert InvalidOptionCount();

        uint256 proposalId = proposalCount++;
        Proposal storage proposal = proposals[proposalId];

        proposal.name = _name;
        proposal.deadline = _deadline;
        proposal.exists = true;

        for (uint i = 0; i < _options.length; i++) {
            proposal.options.push(
                Option({name: _options[i], votes: FHE.asEuint64(0)})
            );
        }

        emit ProposalCreated(proposalId, _name, _deadline);
        return proposalId;
    }

    function vote(uint256 _proposalId, InEuint8 memory _optionIndex) external {
        euint8 optionIndex = FHE.asEuint8(_optionIndex);
        Proposal storage proposal = proposals[_proposalId];

        if (!proposal.exists) revert ProposalNotFound();
        if (block.timestamp >= proposal.deadline) revert DeadlineExpired();
        if (proposal.hasVoted[msg.sender]) revert AlreadyVoted();

        for (uint8 i = 0; i < proposal.options.length; i++) {
            proposal.options[i].votes = FHE.add(
                proposal.options[i].votes,
                FHE.select(
                    optionIndex.eq(FHE.asEuint8(i)),
                    EUINT64_ONE,
                    EUINT64_ZERO
                )
            );
            FHE.allowThis(proposal.options[i].votes);
        }
        proposal.hasVoted[msg.sender] = true;

        FHE.allowSender(optionIndex);
        emit VoteCast(_proposalId, msg.sender, optionIndex);
    }

    function finalizeVote(uint256 _proposalId) external {
        if (msg.sender != owner) revert NotOwner();

        Proposal storage proposal = proposals[_proposalId];
        if (!proposal.exists) revert ProposalNotFound();
        if (block.timestamp < proposal.deadline) revert DeadlineNotReached();

        for (uint8 i = 0; i < proposal.options.length; i++) {
            FHE.decrypt(proposal.options[i].votes);
        }
    }

    function getProposal(
        uint256 _proposalId
    )
        external
        view
        returns (
            string memory name,
            uint256 deadline,
            bool exists,
            string[] memory options,
            uint256[] memory votes,
            bool finalized,
            uint8 winner
        )
    {
        Proposal storage proposal = proposals[_proposalId];

        name = proposal.name;
        deadline = proposal.deadline;
        exists = proposal.exists;

        options = new string[](proposal.options.length);
        for (uint8 i = 0; i < proposal.options.length; i++) {
            options[i] = proposal.options[i].name;
        }

        votes = new uint64[](proposal.options.length);
        finalized = true;
        for (uint8 i = 0; i < proposal.options.length; i++) {
            (uint256 result, bool decrypted) = FHE.getDecryptResultSafe(
                proposal.options[i].votes
            );
            votes[i] = decrypted ? result : 0;
            if (!decrypted) finalized = false;
        }

        if (finalized) {
            uint256 maxVotes = 0;
            winner = 0;
            for (uint8 i = 0; i < proposal.options.length; i++) {
                if (proposal.options[i].votes > maxVotes) {
                    maxVotes = proposal.options[i].votes;
                    winner = i;
                }
            }
        }
    }

    function hasVoted(
        uint256 _proposalId,
        address _voter
    ) external view returns (bool) {
        return proposals[_proposalId].hasVoted[_voter];
    }
}

```
