---
title: Research in Fhenix
sidebar_position: 10
---

Our research explores novel cryptographic techniques to push the boundaries of Fully Homomorphic Encryption (FHE). We mainly delve into optimizing the latency of FHE-based smart contracts using state-of-the-art schemes, ensuring they remain both efficient and secure. Ultimately, our aim is to broaden the practical viability of FHE by delivering protocols that meet real-world performance needs. We also designed a secure high performance threshold decryption protocol (see below).

## Current Project: Threshold Decryption for FHE

We designed a new threshold FHE decryption protocol that achieves both **unprecedented throughput** and **shortest latency** compared to existing solutions. Specifically, it improves **throughput by ~20,000×** and **cuts latency by up to 37×** relative to the state of the art. This is achieved by securely removing ciphertext noise with an efficient MPC-based approach, eliminating the need for noise flooding while maintaining strong simulation-based security.