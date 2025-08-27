---
title: TaskManager
sidebar_position: 1
---

# TaskManager


| Aspect | Description |
|---------|-------------|
| **Type** | Contract deployed on the destination blockchain |
| **Function** | Acts as the on-chain entry point for CoFHE integration |
| Responsibilities | • Initiates FHE operations by serving as the on-chain entry point. The dApp contract calls the FHE.sol library which triggers the TaskManager contract to submit a new encrypted computation task. <br/>• Generates unique handles that act as references to the results of FHE operations. These results are computed asynchronously off-chain. <br/>• Emits structured events containing the unique handle of the ciphertext, operation type, and other required metadata. |
| **Deployment** | A separate Task Manager Contract is deployed for each supported destination chain, enabling chain-specific integrations |
