---
title: CTRegistry
sidebar_position: 5
---

# CTRegistry
| Aspect | Description |
|--------|-------------|
| **Type** | Registry Contract |
| **Function** | Manages the mapping between temporary ciphertext hashes and their actual hash values |
| **Responsibilities** | • Maintains a consistent record of ciphertext identifiers throughout the CoFHE lifecycle<br/>• Enables secure lookup of final ciphertexts using their temporary handles<br/>• Restricts read/write access to ensure integrity and prevent unauthorized updates |

The CTRegistry acts as a source of truth for encrypted data identifiers, mapping temporary hashes to their final computed values. This ensures results from off-chain computation can be securely resolved and verified by their originating requests.
