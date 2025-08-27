# CoFHE Architecture

[![Architecture](../../../static/img/assets/Architecture.svg)](../../../static/img/assets/Architecture.svg)

*Click on the image to view in full size*

## System Overview

CoFHE (Co-processor for Fully Homomorphic Encryption) is designed as a modular, layered architecture that enables privacy-preserving computations on blockchain networks. The system combines on-chain smart contracts with off-chain processing capabilities to deliver secure, efficient fully homomorphic encryption operations.

### Key Components

#### User-Facing Utilities
- **Cofhejs**: A TypeScript library that provides client-side functionality for encrypting inputs, managing permits, and decrypting outputs. Serves as the primary interface between applications and the CoFHE ecosystem.
- **FHE.sol**: The Solidity library that enables smart contracts to perform operations on encrypted data. It exposes a comprehensive API for arithmetic, comparison, and logical operations on encrypted values.

#### Internal Utilities
- **Task Manager**: Acts as the gateway for all FHE operation requests, validating requests and managing permissions through the Access Control Layer (ACL).
- **Aggregator**: Coordinates request queues and manages communication between on-chain contracts and the off-chain execution environment.
- **FHEOS Server**: Executes the actual FHE operations on encrypted data and maintains the encrypted state.
- **Threshold Network**: A distributed system that securely handles decryption requests through multi-party computation, ensuring no single entity can access the decryption key.
- **Ciphertext Registry**: Maintains references to encrypted values and handles access control.

### Data Flows

CoFHE implements several critical data flows that maintain privacy throughout the computation lifecycle:

1. **Encryption Request**: Manages the secure encryption of input data via ZK proofs before it enters the blockchain.
2. **FHE Operation Flow**: Handles the process of requesting and executing computations on encrypted data.
3. **Decryption Request**: Processes requests to decrypt data using the Threshold Network.
4. **Decrypt/Seal Output**: Enables users to access encrypted results while maintaining privacy.

This architecture ensures that data remains encrypted throughout its entire lifecycle while still enabling complex computations, providing a foundation for privacy-preserving blockchain applications.

