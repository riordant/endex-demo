# Endex (Demo)

> A privacy-preserving perpetuals engine for a single ETH market, built on **CoFHE** (Fhenix’s fully homomorphic coprocessor). Position data (notional, long/short, entry price, liquidation price) remains encrypted end-to-end and is revealed only at settlement. Basic perp mechanics are implemented (Funding rate, entry/exit price impact).

---

## Table of contents

- [High-level architecture](#high-level-architecture)
- [Data model & units](#data-model--units)
- [Trade lifecycle](#trade-lifecycle)
- [Funding design](#funding-design)
  - [Rationale & comparisons (GMX, dYdX)](#rationale--comparisons-gmx-dydx)
  - [Market indices & accrual](#market-indices--accrual)
  - [Encrypted OI → plaintext rate (async)](#encrypted-oi--plaintext-rate-async)
  - [Per-position funding at close](#per-position-funding-at-close)
  - [Caveats](#caveats)
- [Encrypted liquidation checks](#encrypted-liquidation-checks)
- [PnL and settlement math](#pnl-and-settlement-math)
- [CoFHE integration](#cofhe-integration)
  - [Why this design suits FHE](#why-this-design-suits-fhe)
  - [Async request/commit](#async-requestcommit)
- [Protocol parameters](#protocol-parameters)
- [Security & privacy considerations](#security--privacy-considerations)
- [Future work](#future-work)
- [References](#references)

---

## High-level architecture

What the system is doing (at a glance)

State machine (driven by the keeper in `EndexKeeper.sol`):
    Requested → Pending → Open → (liq checks) → AwaitingSettlement → {Closed | Liquidated}

All transitions happen inside `EndexKeeper.process(positionIds)` using the current oracle mark, with CoFHE decrypts gating each step.
The state machine model is required, given that CoFHE is an asyncronous execution model. We create a clean structure here such that all operations that require a 'callback' from the coprocessor

*Privacy model*: core position fields that leak info about trader intent/size stay encrypted end-to-end (euint256, ebool). Decrypts are:

- global for system flags (e.g., “is liquidatable?”, “pending done?”),

- owner-scoped for per-position equity breakdowns,

- and view/cadence-scoped for rounded/public funding rate + impact grid.

*Funding*: sign comes from skew (long OI vs short OI), accrues continuously per-second; each position snapshots a side-specific cumulative index at entry and pays/receives `size * (cum_now − cum_entry)` on close/liquidation.

*Impact*: quadratic, skew-aware penalty/rebate split into non-negative buckets (loss vs gain) both at entry (snapshotted) and exit (computed at close).

*Liquidation check*: compares (collateral + gains + entry impact) vs (losses + maintenance requirement). Exit impact is only applied at settlement.

*Settlement*: decrypts net equity, charges close fee, transfers USDC, removes OI, and resets funding rate from new skew.

- **Single market (ETH-USD)**
- **USDC collateral** (6 decimals); **Chainlink** price (8 decimals)
- **LP pool** accumulates liquidity from LPs
- **Reveal policy**: size is revealed **only** at settlement
---

State Machine Flow
1) Opening (async, privacy-preserving)

User call: `openPositionRequest(isLong, size, entryPriceRange, collateral)` → sets `Status.Requested` (encrypted isLong, size, entryPriceRange) and pulls collateral into pendingLiquidity. (`EndexTrading._openPositionRequest`)

Keeper cycle (process)

Requested → Pending: decrypt Validity.requestValid = `_validateSize` && `_validateRange`; if false, refund via _returnUserFunds.

Pending → Open: once `pendingDone` decrypts `true` (ie. mark price within `entryPriceRange`), 
    _openPositionFinalize:

        - Snapshot entry funding index for side (`entryFunding`),

        - Compute entry impact buckets before OI changes (`_encImpactEntryBucketsAtOpenX18`),

        - Update encrypted OI (`encLongOI`/`encShortOI`) and recompute funding rate from skew,

        - Move collateral from pendingLiquidity → totalLiquidity,

        - Status.Open.
All of this is done with encrypted selects, never branching on plaintext. using an encrypted bool in an if statement is not possible with CoFHE, However we can use `FHE.select(ebool, ifTrue, ifFalse)` which will select the right condition via the coprocessor.

---

## Funding design

### Rationale & comparisons (GMX, dYdX)

Perp engines typically **accrue funding continuously** with a **cumulative index** and realize it on **position update or close**.  
- **dYdX**: rate updates hourly; accrual is second-by-second; realized on portfolio change/close.  
- **GMX**: side-dependent funding that adapts to long/short skew; realized when the position changes.

Due to encrypted position data, paying funding on each position update (before close) would leak information about it. Therefore, here, funding is **accrued continuously** but **paid only at settlement**. This avoids any mid-life cashflow that would scale with **size**, thereby preserving size privacy while maintaining the correct economics.

### Market indices & accrual

On `updateFunding()`:

$$
\begin{aligned}
\text{cumFundingLongX18} &\mathrel{+}= r \cdot \Delta t,\\
\text{cumFundingShortX18} &\mathrel{-}= r \cdot \Delta t,
\end{aligned}
$$

with $r=\text{fundingRatePerSecX18}$ (signed X18), $\Delta t$ in seconds.

On `_openPositionFinalize()` (following valid position check):

$$
\text{entryFunding} \gets
\begin{cases}
\text{cumFundingLongX18} & \text{if long}\\
\text{cumFundingShortX18} & \text{if short}
\end{cases}
$$

### Encrypted OI → plaintext rate (async)

We compute the funding **rate** from **encrypted skew** without revealing OI totals:

1. **Request (single snapshot):**
   - Compute **encrypted skew** $\,\text{encSkew} = \text{encLongOI} - \text{encShortOI}\,$.
   - Compute **encrypted numerator** $\,\text{encNum} = \text{encSkew} \cdot K\,$ (constant `FUNDING_K_X12`).
   - Compute encrypted **sign flag** $\,\mathbf{1}_{\text{longOI}\ge\text{shortOI}}\,$.
   - Call `FHE.decrypt(encNum)` and `FHE.decrypt(encFlag)`. Mark `fundingPending`, bump `fundingEpoch`.

2. **Commit (after decrypt ready):**
   - Read `num` and `flag` via `getDecryptResultSafe(...)`.
   - Build **signed** numerator: `signedNum = flag==1 ? +num : -num`.
   - Convert to **per-second X18** rate, **clamp** to bounds, then `updateFunding()` and set `fundingRatePerSecX18`.

Only the **rate** (a single scalar) is revealed; per-position sizes remain private. This aligns with GMX’s *adaptive funding* concept (rate depends on long/short ratio) while minimizing leakage.

### Per-position funding at close

At settlement (after size decrypt):

$$
\text{fundingUSDC} \;=\; S \cdot \frac{\Delta F}{1e18}
\quad\text{where}\quad
\Delta F \;=\; \Big(\text{cumFundingSideX18}\;-\;\text{entryFunding}\Big)
$$

- $S$ is **decrypted** notional (6d).
- For longs, `cumFundingSideX18 = cumFundingLongX18`; for shorts, `cumFundingSideX18 = cumFundingShortX18`.

We **do not** transfer funding mid-life. This is economically equivalent to continuous accrual if liquidation checks include funding (see next section).

### Caveats

- **Rate leakage:** Publishing the **rate** leaks the **sign** and rough magnitude of market skew (by design). We accept this minimal leakage to avoid revealing **aggregate OI** or per-position sizes.
- **Index freshness:** Always invoke `updateFunding()` before using indices (e.g., on open, request, commit, liquidation requests). Stale timestamps lead to under/over-accrual.
- **LP NAV:** If you later allow mid-interval LP deposits/withdrawals priced off pool NAV, consider also tracking a pool-level funding receivable/payable to keep LP share pricing fair (out of scope in the current minimal pool).

---

## Encrypted liquidation checks

Liquidations must “see” funding to avoid bad debt. We compute an **encrypted equity** and compare it to **encrypted maintenance**:

- **Encrypted equity (X18)**:

$$
\text{encEquityX18} = (\text{collateral}\cdot 1e18) + \text{encPnL\\_X18} \pm \text{encFunding\\_X18}
$$

where

$$
\text{encPnL\\_X18} =
\begin{cases}
S\cdot\big(\tfrac{P}{E}\cdot 1e18 - 1e18\big) & \text{long}\\[2pt]
S\cdot\big(1e18 - \tfrac{P}{E}\cdot 1e18\big) & \text{short}
\end{cases}
$$

and $\,\text{encFunding\\_X18} = S \cdot |\Delta F|$; sign applied outside.

- **Maintenance requirement (X18)**:

$$
\text{encReq} = S \cdot \text{MAINT\\_MARGIN\\_BPS} \cdot 1e14
$$

(BPS → X18).

- **Encrypted boolean**: `encEquityX18 < encReq` → encrypt to **0/1 flag**, request decrypt. In a second tx, if `flag==1` we move the position to **AwaitingSettlement** at the stored price. This reveals **only** “liquidate / don’t liquidate,” never the size or thresholds.

---

## PnL and settlement math

At settlement we decrypt `size` and compute:

1. **Price PnL** (USDC, 6d):

$$
\text{PnL} =
\begin{cases}
S\cdot\frac{P - E}{E} & \text{long}\\[6pt]
S\cdot\frac{E - P}{E} & \text{short}
\end{cases}
$$

2. **Funding**:

$$
\text{FundingUSDC} = S \cdot \frac{\Delta F}{1e18}
$$

3. **Payout (gross → fee → net)**:

$$
\text{payoutGross} = \max\big(0,\; \text{collateral} + \text{PnL} - \text{FundingUSDC}\big)
$$

$$
\text{payoutNet} = \text{payoutGross} - \text{closeFeeBps}\cdot\text{payoutGross}
$$

Fee accrues to the pool (LPs).

---

## CoFHE integration

- **Library:** `@fhenixprotocol/cofhe-contracts/FHE.sol`
- **Encrypted types:** `euint256`, `ebool` used for sizes, OI aggregates, and comparison flags
- **Ops are stateful:** `FHE.mul`, `FHE.add`, etc. operate on ciphertexts and **change state**; they’re **not** `view`
- **Access control:** positions call `FHE.allowThis/allowSender` to enable contract/self access to ciphertexts
- **Async decrypt:** `FHE.decrypt(cipher)` starts a threshold decrypt; later poll with `FHE.getDecryptResultSafe(cipher)` → `(value, ready)`

### Why this design suits FHE

- **No mid-life cashflows:** avoids per-interval payouts that would scale with size (preventing leakage)
- **Aggregate OI kept private:** we decrypt **only** a funding **rate**, not OI totals or individual positions

### Async request/commit

```text
Funding rate:
  requestFundingRateFromSkew():
    encSkew = encLongOI - encShortOI
    encNum  = encSkew * K
    encFlag = (encLongOI >= encShortOI) ? 1 : 0
    decrypt(encNum); decrypt(encFlag)
    fundingPending = true; fundingEpoch++

  commitFundingRate(epoch):
    require(fundingPending && epoch == fundingEpoch)
    (num, ready1)  = getDecryptResultSafe(encNum)
    (flag, ready2) = getDecryptResultSafe(encFlag)
    require(ready1 && ready2)
    rate = clamp(sign(flag)*num / 1e6)
    updateFunding(); fundingRatePerSecX18 = rate; fundingPending = false
```

---

## Protocol parameters

- `MAX_LEVERAGE_X = 5`
- `CLOSE_FEE_BPS = 10` (0.10%)
- `MAINT_MARGIN_BPS = 100` (1.00%)
- `FUNDING_K_X12` (encrypted scalar; maps skew → numerator)
- `MAX_ABS_FUNDING_RATE_PER_SEC_X18` (safety bound)
- **Scales:** size 1e6, price 1e8, funding X18

> **Note**: constants are placeholders for a prototype. In production, parameterize via governance and add per-market configs.

---

## Security & privacy considerations

- **Privacy surface**
  - Revealed: **rate** scalar (implies skew sign and rough magnitude), **liq decision bit**, final **payout** at close
  - Hidden: **per-position size** until settlement, **aggregate OI** (kept encrypted), per-position equity/thresholds
- **Oracle correctness**: relies on a Chainlink-style oracle; production systems may use robust feeds with anti-wick measures
- **Async risk**: decryption latency—tests simulate ~10s; the request/commit pattern includes an `epoch` to prevent race/replay
- **Insolvency check**: settlement requires `payoutNet <= totalLiquidity`; future versions may add insurance/reserve

---

---

## Future work

- **Encrypted TP/SL**: mirror liquidation’s encrypted trigger
- **Cross-margin & multi-asset**: extend beyond isolated ETH
- **LP share pricing / NAV**: funding receivable/payable buckets for fair mid-interval LP actions
- **Governance & pausing**: admin controls and graceful handling of decrypt delays
- **ZK attestations**: proofs of correct encrypted computations (longer-term)

---

## References

- GMX V2 docs & design discussions (funding, liquidation, oracle principles)
- dYdX docs (hourly funding updates, continuous accrual)
- Fhenix CoFHE docs (FHE.sol operations, async decrypt network)

---

### Appendix — exact formulas & scales

Let:

- $S$ = position **size** (USDC $1e6$), encrypted during life, decrypted at settlement  
- $E$ = entry price ($1e8$), $P$ = settlement price ($1e8$)  
- $F(t)$ = cumulative funding index for the side (X18)  
- $\Delta F = F(t_{\text{settle}}) - F(t_{\text{open}})$ (X18)  
- $r$ = fundingRatePerSecX18 (X18), $dt$ in seconds

**Accrual**  

$$
F_{\text{long}} \mathrel{+}= r\cdot dt,\qquad
F_{\text{short}} \mathrel{-}= r\cdot dt
$$

**Price PnL**  

$$
\text{PnL} =
\begin{cases}
S\cdot \dfrac{P - E}{E}, & \text{long}\\[6pt]
S\cdot \dfrac{E - P}{E}, & \text{short}
\end{cases}
$$

**Funding**  

$$
\text{FundingUSDC} = S \cdot \dfrac{\Delta F}{1e18}
$$

**Equity (X18) for liquidation**

$$
\begin{aligned}
\text{encEquityX18}
&= \text{collateral}\cdot 1e18 \\
&\quad {}+ \text{encPnL\\_X18} \\
&\quad \pm \text{encFunding\\_X18}
\end{aligned}
$$

**Maintenance (X18)**  

$$
\text{encReq} = S \cdot \text{MAINT\\_MARGIN\\_BPS} \cdot 1e14
$$

**Payout**  

$$
\text{payoutNet}
= \max\!\big(0,\ \text{collateral}+\text{PnL}-\text{Funding}\big)
\cdot \Big(1-\tfrac{\text{closeFeeBps}}{10{,}000}\Big)
$$



# Development

## Prerequisites

- Node.js (v18 or later)
- bun (recommended package manager)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/riordant/endex-demo.git
cd cofhe-hardhat-starter
```

2. Install dependencies:

```bash
bun install
```

## Available Scripts

### Development

- `bun compile` - Compile the smart contracts
- `bun clean` - Clean the project artifacts
- `bun test` - Run tests on the local CoFHE network
- `bun test:hardhat` - Run tests on the Hardhat network
- `bun test:localcofhe` - Run tests on the local CoFHE network

### Local CoFHE Network

- `bun localcofhe:start` - Start a local CoFHE network
- `bun localcofhe:stop` - Stop the local CoFHE network
- `bun localcofhe:faucet` - Get test tokens from the faucet
- `bun localcofhe:deploy` - Deploy contracts to the local CoFHE network

## `cofhejs` and `cofhe-hardhat-plugin`

This project uses cofhejs and the CoFHE Hardhat plugin to interact with FHE (Fully Homomorphic Encryption) smart contracts. Here are the key features and utilities:

### cofhejs Features

- **Encryption/Decryption**: Encrypt and decrypt values using FHE

  ```typescript
  import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'

  // Encrypt a value
  const [encryptedInput] = await cofhejs.encrypt(
  	(step) => {
  		console.log(`Encrypt step - ${step}`)
  	},
  	[Encryptable.uint32(5n)]
  )

  // Decrypt a value
  const decryptedResult = await cofhejs.decrypt(encryptedValue, FheTypes.Uint32)
  ```

- **Unsealing**: Unseal encrypted values from the blockchain
  ```typescript
  const unsealedResult = await cofhejs.unseal(encryptedValue, FheTypes.Uint32)
  ```

### `cofhe-hardhat-plugin` Features

- **Network Configuration**: Automatically configures the cofhe enabled networks
- **Wallet Funding**: Automatically funds wallets on the local network

  ```typescript
  import { localcofheFundWalletIfNeeded } from 'cofhe-hardhat-plugin'
  await localcofheFundWalletIfNeeded(hre, walletAddress)
  ```

- **Signer Initialization**: Initialize cofhejs with a Hardhat signer

  ```typescript
  import { cofhejs_initializeWithHardhatSigner } from 'cofhe-hardhat-plugin'
  await cofhejs_initializeWithHardhatSigner(signer)
  ```

- **Testing Utilities**: Helper functions for testing FHE contracts
  ```typescript
  import { expectResultSuccess, expectResultValue, mock_expectPlaintext, isPermittedCofheEnvironment } from 'cofhe-hardhat-plugin'
  ```

### Environment Configuration

The plugin supports different environments:

- `MOCK`: For testing with mocked FHE operations
- `LOCAL`: For testing with a local CoFHE network (whitelist only)
- `TESTNET`: For testing and tasks using `arb-sepolia` and `eth-sepolia`

You can check the current environment using:

```typescript
if (!isPermittedCofheEnvironment(hre, 'MOCK')) {
	// Skip test or handle accordingly
}
```

## Links and Additional Resources

### `cofhejs`

[`cofhejs`](https://github.com/FhenixProtocol/cofhejs) is the JavaScript/TypeScript library for interacting with FHE smart contracts. It provides functions for encryption, decryption, and unsealing FHE values.

#### Key Features

- Encryption of data before sending to FHE contracts
- Unsealing encrypted values from contracts
- Managing permits for secure contract interactions
- Integration with Web3 libraries (ethers.js and viem)

### `cofhe-mock-contracts`

[`cofhe-mock-contracts`](https://github.com/FhenixProtocol/cofhe-mock-contracts) provides mock implementations of CoFHE contracts for testing FHE functionality without the actual coprocessor.

#### Features

- Mock implementations of core CoFHE contracts:
  - MockTaskManager
  - MockQueryDecrypter
  - MockZkVerifier
  - ACL (Access Control List)
- Synchronous operation simulation with mock delays
- On-chain access to unencrypted values for testing

#### Integration with Hardhat and cofhejs

Both `cofhejs` and `cofhe-hardhat-plugin` interact directly with the mock contracts:

- When imported in `hardhat.config.ts`, `cofhe-hardhat-plugin` injects necessary mock contracts into the Hardhat testnet
- `cofhejs` automatically detects mock contracts and adjusts behavior for test environments

#### Mock Behavior Differences

- **Symbolic Execution**: In mocks, ciphertext hashes point to plaintext values stored on-chain
- **On-chain Decryption**: Mock decryption adds simulated delays to mimic real behavior
- **ZK Verification**: Mock verifier handles on-chain storage of encrypted inputs
- **Off-chain Decryption**: When using `cofhejs.unseal()`, mocks return plaintext values directly from on-chain storage

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
