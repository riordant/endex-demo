---
title: Threshold Network
sidebar_position: 8
---

# Threshold Network

| Aspect               | Description                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Type**             | Offchain, distributed network.                                                                                                    |
| **Function**         | Process and execute decryption requests.                                                                                          |
| **Responsibilities** | • Gets ciphertext decryption requests<br/>• Authenticates and validates them<br/>• Runs an MPC protocol to decrypt the ciphertext |

In any system utilizing encryption, a crucial step is the eventual decryption of data. For example, if we were to build a privacy-preserving ERC20 contract, users would ultimately need to access their encrypted balances. In the case of CoFHE, this decryption process is managed by the Threshold Network.

## Motivation

The Threshold Network is a component of a complex cryptographic system with the sole purpose of enhancing the security and trustworthiness of the system by distributing control of the decryption process. Rather than having a single secret key stored and used for the decryption by a centralized entity, we distribute secret shares (to hide the original decryption key) among multiple parties. This enforces collaboration among parties in order to decrypt; the parties perform an MPC (Multi-Party Computation) protocol that results in the decrypted value of a given ciphertext block (single ciphertext can contain a multiple of these so called blocks), ensuring that no information about the full secret key is leaked at any time.

A practical example of a threshold network in practice is vote counting. Multiple representatives of competing parties gather around to count votes from recent elections. In order to attempt voter fraud all of the participating parties would have to collaborate (which is unlikely). Threshold Network is built on the exact same principle.

## Concept

Threshold Network performs decryption operations. The Threshold Network is currently initialized by a Trusted Dealer (in the future, we plan to eliminate the Trusted Dealer). The Dealer initially generates a key. The Trusted Dealer uses the private key within a secret-sharing algorithm to generate secret shares to share among individual members. Each member holds exactly one secret share. To perform a decryption, the secret shares are used to perform partial decryptions through a multiparty computation (MPC) protocol. These partial decryptions are then combined into the final plaintext. The protocol requires cooperation from all participants to perform a decryption, ensuring no single entity can decrypt the ciphertext alone. This distributed control mechanism enhances security by preventing unilateral access to encrypted data.

## Decryption Process

The Threshold network includes three main components:

- Coordinator - coordinates communication between the party members to perform the MPC protocol.
- Party Members - the individual parties that hold a secret share and execute the MPC protocol.
- Trusted Dealer - responsible for initializing the protocol, and for providing random data to the party members, needed to perform the protocol securely.

![Threshold Network Flow](../../../../static/img/threshold-network.svg)

All incoming decryption requests reach the Coordinator (1).
The coordinator splits the CT into individual Learning With Errors (LWE) CT blocks. These blocks then get broadcast to partymembers (2). During this process data is exchanged back and forth until the decryption of all blocks is complete upon which the coordinator reassembles the plaintext from decrypted LWE CT blocks. The plaintext value then gets sent back to the user.

The MPC protocol consists of multiple stages. In each stage, a partymember performs a calculation on a received input and returns the result (a.k.a. intermediate result) to the Coordinator. Each intermediate result gets sent back to the coordinator in order to get distributed among other partymembers as an input for the next stage.
