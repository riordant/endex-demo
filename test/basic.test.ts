// test/basic.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable } from 'cofhejs/node'
import { expect } from 'chai'

function toUSDC(n: bigint) { return n * 10n ** 6n }    // 6 decimals
function price(n: bigint)  { return n * 10n ** 8n }    // 8 decimals
const ONE_X18 = 10n ** 18n

// CoFHE decrypts async
function coprocessor(ms = 10_000) {
  console.log("waiting for coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}

// Baseline payout net (no funding, no price impact) used for direction checks.
// PnL = size * (P-E)/E
function baselineNetPayout(
  collateral: bigint,
  sizeNotional: bigint,
  entryPx: bigint,   // 8d
  closePx: bigint,   // 8d
  closeFeeBps: bigint // e.g. 10n for 0.10%
): bigint {
  const pnl = (sizeNotional * (closePx - entryPx)) / entryPx
  let gross = collateral + pnl
  if (gross < 0n) gross = 0n
  const fee = (gross * closeFeeBps) / 10_000n
  return gross - fee
}

describe('Endex — funding, encrypted liquidation & price impact', function () {
  async function deployFixture() {
    const [deployer, user, lp, keeper, other] = await hre.ethers.getSigners()

    // Mock USDC
    const USDC = await hre.ethers.getContractFactory('MintableToken')
    const usdc = await USDC.deploy('USDC', 'USDC', 6)
    const usdcAddr = await usdc.getAddress()

    // Chainlink mock @ $2000 (8d)
    const Feed = await hre.ethers.getContractFactory('MockV3Aggregator')
    const feed = await Feed.deploy(8, price(2000n))
    const feedAddr = await feed.getAddress()

    // Perps
    const Perps = await hre.ethers.getContractFactory('Endex')
    const perps = await Perps.deploy(usdcAddr, feedAddr)
    const perpsAddr = await perps.getAddress()

    return { perps, perpsAddr, usdc, feed, deployer, user, lp, keeper, other }
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    hre.cofhe.mocks.enableLogs()
  })

  // -----------------------------
  // Existing (adjusted) funding test
  // -----------------------------
  it('accrues funding via async request/commit and charges it only at settlement', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp } = await loadFixture(deployFixture)

    // LP capital
    await usdc.mint(lp.address, toUSDC(1_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(1_000_000n))

    // User funds
    await usdc.mint(user.address, toUSDC(50_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)

    // Init CoFHE
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // Open long: collateral 10k, size 30k (3x)
    const collateral = toUSDC(10_000n)
    const notional  = toUSDC(30_000n)
    const [encSize] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notional)])
    )

    const userBalStart = BigInt(await usdc.balanceOf(user.address))

    await perps.connect(user).openPosition(
      true, encSize, collateral, 0, 0
    )

    let pos = await perps.getPosition(1)
    expect(pos.status).to.equal(0) // Open
    expect(pos.entryPrice).to.equal(price(2000n))

    // === Async funding rate: request (snapshots skew, starts decrypts) ===
    const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
    await perps.requestFundingRateFromSkew()
    const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
    expect(await perps.fundingPending()).to.equal(true)

    // Wait for decrypts of numerator+flag
    await coprocessor()

    // === Commit with epoch ===
    await perps.commitFundingRate(epoch)
    expect(await perps.fundingPending()).to.equal(false)

    // Advance time and accrue with current rate
    const dt = 24 * 3600 // 1 day
    await time.increase(dt)
    await perps.pokeFunding()

    // Check cumulative vs entry snapshot (for settlement math)
    const cumLong = BigInt(await perps.cumFundingLongX18())
    const entryFunding = BigInt((await perps.getPosition(1)).entryFundingX18)
    const fundingDeltaX18 = cumLong - entryFunding

    // Ensure no interim cashflows to user
    const userBalPreClose = BigInt(await usdc.balanceOf(user.address))
    expect(userBalPreClose).to.equal(userBalStart - collateral)

    // Move price up +5% to generate PnL; funding should reduce or increase payout depending on sign
    await feed.updateAnswer(price(2100n))

    // Close → AwaitingSettlement (requests size decrypt)
    await perps.connect(user).closePosition(1)
    pos = await perps.getPosition(1)
    expect(pos.status).to.equal(1)

    // Wait for size decrypt
    await coprocessor()

    // Settle
    await perps.settlePositions([1])
    pos = await perps.getPosition(1)
    expect([3n, 2n]).to.include(pos.status) // Closed or (edge) Liquidated

    // Verify settlement-only effect on user balance — actual must be <= baseline (impact + possibly negative funding)
    const userBalEnd = BigInt(await usdc.balanceOf(user.address))

    // Baseline (no impact, funding=observed sign) — here we build baseline ignoring impact only,
    // but we know impact never *increases* payout for a first long (skew>=0 at entry).
    const baseNoImpact = baselineNetPayout(
      collateral, notional, price(2000n), price(2100n), 10n
    )
    const expectedMaxEnd = userBalStart - collateral + baseNoImpact

    expect(userBalEnd <= expectedMaxEnd).to.eq(true)
  })

  // -----------------------------
  // Existing encrypted liquidation
  // -----------------------------
  it('performs encrypted liquidation via request → finalize → settle', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(1_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(1_000_000n))

    await usdc.mint(user.address, toUSDC(30_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // 4x long likely to liquidate on large drop
    const collateral = toUSDC(5_000n)
    const notional  = toUSDC(20_000n)
    const [encSize] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notional)])
    )

    await perps.connect(user).openPosition(true, encSize, collateral, 0, 0)

    // Big drop to force liquidation
    await feed.updateAnswer(price(1500n))

    // Step 1: request encrypted liq flags (starts decrypts)
    await perps.requestLiqChecks([1])
    await coprocessor()

    // Step 2: finalize; should move to AwaitingSettlement when flag == 1
    await perps.finalizeLiqChecks([1])
    let pos = await perps.getPosition(1)
    expect(pos.status).to.equal(1) // AwaitingSettlement

    // Wait for size decrypt triggered in setup
    await coprocessor()

    // Settle; expect Liquidated most likely
    await perps.settlePositions([1])
    pos = await perps.getPosition(1)
    expect([2n, 3n]).to.include(pos.status)
  })

  // -----------------------------
  // Negative intermediaries guard
  // -----------------------------
  it('handles deep negative price PnL without underflow', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(1_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(1_000_000n))

    await usdc.mint(user.address, toUSDC(30_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const collateral = toUSDC(5_000n)
    const notional  = toUSDC(20_000n)
    const [encSize] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notional)])
    )

    await perps.connect(user).openPosition(true, encSize, collateral, 0, 0)

    // ~50% drop (2000 -> 1000) would make (ratio - 1) negative if naive; our buckets avoid underflow
    await feed.updateAnswer(price(1000n))

    await perps.requestLiqChecks([1])
    await coprocessor()
    await perps.finalizeLiqChecks([1])

    let pos = await perps.getPosition(1)
    expect(pos.status).to.equal(1) // AwaitingSettlement — compare succeeded, no underflow

    await coprocessor()
    await perps.settlePositions([1])
    pos = await perps.getPosition(1)
    expect([2n, 3n]).to.include(pos.status)
  })

  // -----------------------------
  // Funding sign sanity (shorts dominate)
  // -----------------------------
  it('commits negative funding rate when shorts dominate (no underflow on |skew|)', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp } = await loadFixture(deployFixture)

    // LP & user setup
    await usdc.mint(lp.address, toUSDC(1_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(1_000_000n))

    await usdc.mint(user.address, toUSDC(50_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // Open a SHORT only so that encShortOI > encLongOI at request time
    const collateral = toUSDC(10_000n)
    const notional  = toUSDC(40_000n) // large short to dominate skew
    const [encSize] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notional)])
    )
    await perps.connect(user).openPosition(false, encSize, collateral, 0, 0)

    // Request → commit funding rate; should be NEGATIVE (flag==0 path)
    const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
    await perps.requestFundingRateFromSkew()
    const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
    await coprocessor()
    await perps.commitFundingRate(epoch)

    const rateX18 = BigInt(await perps.fundingRatePerSecX18())
    expect(rateX18 < 0n).to.be.true // negative funding ⇒ correct sign

    // Advance time and accrue to ensure indices move in the expected directions
    await time.increase(6 * 3600) // 6 hours
    const beforeLong = BigInt(await perps.cumFundingLongX18())
    const beforeShort = BigInt(await perps.cumFundingShortX18())
    await perps.pokeFunding()
    const afterLong = BigInt(await perps.cumFundingLongX18())
    const afterShort = BigInt(await perps.cumFundingShortX18())

    // With negative rate: cumFundingLong decreases, cumFundingShort increases
    expect(afterLong < beforeLong).to.be.true
    expect(afterShort > beforeShort).to.be.true
  })

  // =============================
  // NEW: Price Impact tests
  // =============================

  it('long @ zero price change ends <= baseline (entry impact loss for long on non-negative skew)', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp } = await loadFixture(deployFixture)

    // LP and user
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

    await usdc.mint(user.address, toUSDC(200_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // First trade is LONG => skew >= 0 at entry.
    const collateral = toUSDC(20_000n)
    const notional  = toUSDC(80_000n) // 4x
    const [encSize] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notional)])
    )

    const userStart = BigInt(await usdc.balanceOf(user.address))
    const entryPx = price(2000n)

    await perps.connect(user).openPosition(true, encSize, collateral, 0, 0)

    // Keep price unchanged
    await feed.updateAnswer(entryPx)

    // Close → AwaitingSettlement
    await perps.connect(user).closePosition(1)
    await coprocessor()
    await perps.settlePositions([1])

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    const baseNoImpact = baselineNetPayout(collateral, notional, entryPx, entryPx, 10n)
    const expectedMax = userStart - collateral + baseNoImpact

    // With entry impact, payout should be <= baseline
    expect(userEnd <= expectedMax).to.eq(true)
  })

  it('short on positive skew @ zero price change ends >= baseline (entry impact gain for short)', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp, other } = await loadFixture(deployFixture)
  
    // Fund LP
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))
  
    // Fund users
    await usdc.mint(user.address, toUSDC(200_000n))
    await usdc.mint(other.address, toUSDC(200_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await usdc.connect(other).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(other))
  
    const entryPx = price(2000n)
  
    // 1) Create **positive skew**: OTHER opens a large LONG first.
    {
      const collateralL = toUSDC(40_000n)
      const notionalL   = toUSDC(160_000n) // 4x
      const [encSizeL]  = await hre.cofhe.expectResultSuccess(
        cofhejs.encrypt([Encryptable.uint256(notionalL)])
      )
      await perps.connect(other).openPosition(true, encSizeL, collateralL, 0, 0)
    }
  
    // 2) USER opens a SHORT on positive skew ⇒ short should receive positive entry impact.
    const collateral = toUSDC(20_000n)
    const notional  = toUSDC(80_000n)
    const [encSize] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notional)])
    )
  
    const userStart = BigInt(await usdc.balanceOf(user.address))
    await perps.connect(user).openPosition(false, encSize, collateral, 0, 0)
  
    // Keep price unchanged
    await feed.updateAnswer(entryPx)
  
    // Close & settle
    await perps.connect(user).closePosition(2) // user's position is id=2
    await coprocessor()
    await perps.settlePositions([2])
  
    const userEnd = BigInt(await usdc.balanceOf(user.address))
    const baseNoImpact = ((): bigint => {
      const pnl = (notional * (entryPx - entryPx)) / entryPx // zero
      let gross = collateral + pnl
      if (gross < 0n) gross = 0n
      const fee = (gross * 10n) / 10_000n // 10 bps close fee
      return gross - fee
    })()
    const expectedMin = userStart - collateral + baseNoImpact
  
    // With positive skew at entry, a SHORT receives positive entry impact ⇒ >= baseline
    expect(userEnd >= expectedMin).to.eq(true)
  })

  it('long opened after large short (negative skew) ends >= baseline at zero price change', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp, other } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(3_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(3_000_000n))

    // Two users so we can create skew with one and trade with the other
    await usdc.mint(user.address, toUSDC(200_000n))
    await usdc.mint(other.address, toUSDC(200_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await usdc.connect(other).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(other))

    // 1) OTHER opens a big SHORT to push skew negative
    {
      const collateral = toUSDC(40_000n)
      const notional  = toUSDC(200_000n) // 5x
      const [encSize] = await hre.cofhe.expectResultSuccess(
        cofhejs.encrypt([Encryptable.uint256(notional)])
      )
      await perps.connect(other).openPosition(false, encSize, collateral, 0, 0)
    }

    // 2) USER opens LONG after skew is negative => long should receive positive entry impact
    const collateral = toUSDC(20_000n)
    const notional  = toUSDC(80_000n)
    const [encSize2] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notional)])
    )

    const userStart = BigInt(await usdc.balanceOf(user.address))
    const entryPx = price(2000n)

    await perps.connect(user).openPosition(true, encSize2, collateral, 0, 0)

    // Zero price move
    await feed.updateAnswer(entryPx)

    // Close & settle
    await perps.connect(user).closePosition(2) // user's position is id=2
    await coprocessor()
    await perps.settlePositions([2])

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    const baseNoImpact = baselineNetPayout(collateral, notional, entryPx, entryPx, 10n)
    const expectedMin = userStart - collateral + baseNoImpact

    // With negative skew at entry, long receives positive entry impact => >= baseline
    expect(userEnd >= expectedMin).to.eq(true)
  })
})
