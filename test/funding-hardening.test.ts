// test/funding-hardening.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable } from 'cofhejs/node'
import { expect } from 'chai'

function toUSDC(n: bigint) { return n * 10n ** 6n }    // 6 decimals
function price(n: bigint)  { return n * 10n ** 8n }    // 8 decimals
const ONE_X18 = 10n ** 18n

// CoFHE decrypts async
function coprocessor(ms = 10_000) {
  console.log("waiting on coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}

describe('Endex — funding hardening tests', function () {
  async function deployFixture() {
    const [deployer, userA, userB, lp, keeper] = await hre.ethers.getSigners()

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

    return { perps, perpsAddr, usdc, feed, deployer, userA, userB, lp, keeper }
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    //hre.cofhe.mocks.enableLogs()
  })

  // -------------------------------
  // 1) Sign/scale correctness
  // -------------------------------
  it('funding sign tracks skew (long>short → rate>0, short>long → rate<0), across multiple magnitudes', async function () {
    const { perps, perpsAddr, usdc, userA, lp } = await loadFixture(deployFixture)

    // LP capital
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

    // Seed user funds
    await usdc.mint(userA.address, toUSDC(400_000n))
    await usdc.connect(userA).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userA))

    // tuples: [longNotional, shortNotional]
    const cases: Array<[bigint, bigint]> = [
      [toUSDC(50_000n), toUSDC(10_000n)],   // long > short => rate > 0
      [toUSDC(90_000n), toUSDC(150_000n)],  // long < short => rate < 0
      [toUSDC(100_000n), toUSDC(100_000n)], // long == short => rate ≈ 0
      [toUSDC(10_000n), toUSDC(500_000n)],  // fuzz: strong negative skew => rate < 0
      [toUSDC(400_000n), toUSDC(5_000n)],   // fuzz: strong positive skew => rate > 0
    ]

    for (const [L, S] of cases) {
      // Open positions fresh each iteration (use new fixture to isolate OI) for clean skew
      const { perps: p2, perpsAddr: addr2, usdc: u2, userA: uA2, lp: lp2 } = await loadFixture(deployFixture)

      await u2.mint(lp2.address, toUSDC(2_000_000n))
      await u2.connect(lp2).approve(addr2, hre.ethers.MaxUint256)
      await p2.connect(lp2).lpDeposit(toUSDC(2_000_000n))

      await u2.mint(uA2.address, toUSDC(800_000n))
      await u2.connect(uA2).approve(addr2, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(uA2))

      // Long leg (if > 0)
      if (L > 0n) {
        const [eL] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(L)]))
        await p2.connect(uA2).openPosition(true, eL, toUSDC(20_000n), 0, 0)
      }

      // Short leg (if > 0)
      if (S > 0n) {
        const [eS] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(S)]))
        await p2.connect(uA2).openPosition(false, eS, toUSDC(20_000n), 0, 0)
      }

      const epochBefore = Number(await p2.fundingEpoch?.().catch(() => 0))
      await p2.requestFundingRateFromSkew()
      const epoch = Number(await p2.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await p2.commitFundingRate(epoch)

      const rateX18 = BigInt(await p2.fundingRatePerSecX18())
      if (L > S) expect(rateX18 > 0n).to.eq(true)          // positive skew → rate > 0
      else if (L < S) expect(rateX18 < 0n).to.eq(true)     // negative skew → rate < 0
      else expect(rateX18 === 0n).to.eq(true)              // equal skew → ~0 (within mocks, exactly 0)
    }
  }).timeout(120000);

  // --------------------------------------------
  // 2) Liquidations include funding at settlement
  // --------------------------------------------
  it('liquidated LONG under positive rate explicitly pays funding (actual ≈ baseline - size*dF/1e18)', async function () {
    const { perps, perpsAddr, usdc, feed, userA, lp } = await loadFixture(deployFixture)
  
    // Pool & user
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))
  
    await usdc.mint(userA.address, toUSDC(200_000n))
    await usdc.connect(userA).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userA))
  
    // 1) Ensure POSITIVE rate: open a large LONG to bias skew => longs pay
    {
      const [eL] = await hre.cofhe.expectResultSuccess(
        cofhejs.encrypt([Encryptable.uint256(toUSDC(120_000n))])
      )
      await perps.connect(userA).openPosition(true, eL, toUSDC(20_000n), 0, 0)
  
      const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
      await perps.requestFundingRateFromSkew()
      const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await perps.commitFundingRate(epoch)
  
      const r = BigInt(await perps.fundingRatePerSecX18())
      expect(r > 0n, 'expected positive funding rate (longs pay)').to.eq(true)
    }
  
    // 2) Open a 5x LONG we will liquidate with small *positive* equity at liq price
    const collateralL = toUSDC(5_000n)
    const notionalL  = toUSDC(25_000n) // 5x
    const [encSizeL] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalL)])
    )
    await perps.connect(userA).openPosition(true, encSizeL, collateralL, 0, 0)
  
    // Accrue funding meaningfully
    await time.increase(3 * 24 * 3600) // 3 days
    await perps.pokeFunding()
  
    // Price low enough to liquidate, but still equity > 0 (baseline)
    // Entry 2000 → at 1619: pnl = 25k * (1619-2000)/2000 = -4,762.5 → equity ~ 237.5 > 0
    await feed.updateAnswer(price(1619n))
  
    // Snapshot funding delta for this position (id = 2)
    const pos2_before = await perps.getPosition(2)
    const cumLong = BigInt(await perps.cumFundingLongX18())
    const entryFunding2 = BigInt(pos2_before.entryFundingX18)
    let dF = cumLong - entryFunding2
    expect(dF > 0n, 'dF should be positive for longs when rate>0').to.eq(true)
  
    // Liquidation flow
    await perps.requestLiqChecks([2])
    await coprocessor()
    await perps.finalizeLiqChecks([2])
  
    // Optional: avoid accrual drift
    await perps.pokeFunding()
  
    // Settle and observe actual transfer
    await coprocessor()
    const userStart = BigInt(await usdc.balanceOf(userA.address))
    await perps.settlePositions([2])
    const userEnd = BigInt(await usdc.balanceOf(userA.address))
    const actualPayout = userEnd - userStart
  
    // --- Compute baselines ---
    // Baseline w/o funding (PnL only)
    const pnl = (notionalL * (1619n - 2000n)) / 2000n // negative
    let grossBaseline = collateralL + pnl
    if (grossBaseline < 0n) grossBaseline = 0n
    const feeBaseline = (grossBaseline * 10n) / 10_000n // CLOSE_FEE_BPS = 10
    const netBaseline = grossBaseline - feeBaseline
  
    // With funding: grossWithF = max(0, collateral + pnl - notional * dF / 1e18)
    let fundingUSDC = (notionalL * dF) / ONE_X18
    let grossWithF = collateralL + pnl - fundingUSDC
    if (grossWithF < 0n) grossWithF = 0n
    const feeWithF = (grossWithF * 10n) / 10_000n
    const netWithF = grossWithF - feeWithF
  
    // Funding should reduce payout versus baseline, and actual ≈ netWithF
    const EPS = 50_000n // small slack for rounding (0.05 USDC)
    expect(actualPayout + EPS <= netBaseline, 'funding should not increase payout').to.eq(true)
    expect(actualPayout >= 0n).to.eq(true)
    // Tight check to the computed funding-inclusive payout
    const diff = actualPayout > netWithF ? actualPayout - netWithF : netWithF - actualPayout
    expect(diff <= EPS, `actual ${actualPayout} vs expected ${netWithF} (|Δ|=${diff})`).to.eq(true)
  })

  it('liquidated SHORT under negative rate explicitly pays funding (actual ≈ baseline - size*dF/1e18)', async function () {
    const { perps, perpsAddr, usdc, feed, userA, lp } = await loadFixture(deployFixture)
  
    // Pool & user
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))
  
    await usdc.mint(userA.address, toUSDC(200_000n))
    await usdc.connect(userA).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userA))
  
    // Ensure NEGATIVE rate: open a large SHORT only to bias skew (shorts pay)
    {
      const [eS] = await hre.cofhe.expectResultSuccess(
        cofhejs.encrypt([Encryptable.uint256(toUSDC(150_000n))])
      )
      await perps.connect(userA).openPosition(false, eS, toUSDC(30_000n), 0, 0)
      const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
      await perps.requestFundingRateFromSkew()
      const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await perps.commitFundingRate(epoch)
      const rate = BigInt(await perps.fundingRatePerSecX18())
      expect(rate < 0n, 'expected negative funding rate (shorts pay)').to.eq(true)
    }
  
    // Open the HIGH-LEV SHORT we will liquidate
    const collateralS = toUSDC(6_000n)
    const notionalS  = toUSDC(30_000n) // 5x
    const [encSizeS] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalS)])
    )
    await perps.connect(userA).openPosition(false, encSizeS, collateralS, 0, 0)
  
    // Accrue funding for a bit
    await time.increase(6 * 3600) // 6h
    await perps.pokeFunding()
  
    // Pick price that liquidates but leaves positive baseline equity
    // For E=2000, size=30k, coll=6k: P=2390 → equity ≈ 150 (positive), maintenance > 150 → liquidate
    await feed.updateAnswer(price(2390n))
  
    // Liquidation flow -> AwaitingSettlement
    await perps.requestLiqChecks([2])
    await coprocessor()
    await perps.finalizeLiqChecks([2])
  
    // Freeze funding at settlement boundary and compute dF for the short
    await perps.pokeFunding()
    const pos = await perps.getPosition(2)
    const entryFunding = BigInt(pos.entryFundingX18)
    const cumShortNow  = BigInt(await perps.cumFundingShortX18())
    const dF = cumShortNow - entryFunding
    expect(dF > 0n, 'short dF should be positive under negative rate').to.eq(true)
  
    // Settle; measure only settlement effect on user balance
    await coprocessor() // size decrypt
    const userStart = BigInt(await usdc.balanceOf(userA.address))
    await perps.settlePositions([2])
    const userEnd = BigInt(await usdc.balanceOf(userA.address))
    const actualPayout = userEnd - userStart
  
    // ---- Expected numbers (mirror contract math):
    // Baseline ignoring funding
    const E = 2000n
    const P = 2390n
    const pnl = (notionalS * (E - P)) / E // negative for short
    let payoutGrossBaseline = collateralS + pnl
    if (payoutGrossBaseline < 0n) payoutGrossBaseline = 0n
    const closeFeeBps = 10n
    const feeBaseline = (payoutGrossBaseline * closeFeeBps) / 10_000n
    const netBaseline = payoutGrossBaseline - feeBaseline
  
    // Funding (short pays under negative rate): size * dF / 1e18
    const fundingUSDC = (notionalS * dF) / ONE_X18
    let payoutGrossWithF = collateralS + pnl - fundingUSDC
    if (payoutGrossWithF < 0n) payoutGrossWithF = 0n
    const feeWithF = (payoutGrossWithF * closeFeeBps) / 10_000n
    const netWithF = payoutGrossWithF - feeWithF
  
    // Assertions:
    // 1) Funding reduces payout vs baseline
    expect(netWithF <= netBaseline).to.eq(true)
  
    // 2) Actual ≤ baseline (funding + entry-impact debit cannot increase payout)
    const EPS = 50_000n // $0.05 slack for rounding / tiny price impact debit
    expect(actualPayout <= netBaseline + EPS, 'actual should not exceed baseline').to.eq(true)
  
    // 3) Actual close to funding-inclusive expected (minor differences from integer rounding + entry impact)
    const diff = actualPayout > netWithF ? actualPayout - netWithF : netWithF - actualPayout
    expect(diff <= EPS, `actual ${actualPayout} vs expected ${netWithF} (|Δ|=${diff})`).to.eq(true)
  })

  // -------------------------------------------------------
  // 3) Zero-price-move fairness (mirror + mixed sizes)
  // -------------------------------------------------------
  it('zero price move: positive rate → long <= baseline, short >= baseline (mirror)', async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp } = await loadFixture(deployFixture)

    // Pool & users
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(300_000n))
      await usdc.connect(u).approve(perpsAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u))
    }

    // Create positive rate (long>short)
    {
      const [eL] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(120_000n))]))
      await perps.connect(userA).openPosition(true, eL, toUSDC(20_000n), 0, 0)
      const [eS] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(30_000n))]))
      await perps.connect(userB).openPosition(false, eS, toUSDC(10_000n), 0, 0)

      const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
      await perps.requestFundingRateFromSkew()
      const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await perps.commitFundingRate(epoch)
      const rate = BigInt(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true)
    }

    // Zero price change, accrue funding
    const ePx = price(2000n)
    await feed.updateAnswer(ePx)
    await time.increase(6 * 3600)
    await perps.pokeFunding()

    // Close long (payer) and short (receiver)
    const userALStart = BigInt(await usdc.balanceOf(userA.address))
    await perps.connect(userA).closePosition(1)
    await coprocessor()
    await perps.settlePositions([1])
    const userALEnd = BigInt(await usdc.balanceOf(userA.address))

    const userBSStart = BigInt(await usdc.balanceOf(userB.address))
    await perps.connect(userB).closePosition(2)
    await coprocessor()
    await perps.settlePositions([2])
    const userBSEnd = BigInt(await usdc.balanceOf(userB.address))

    // Baseline (no price change, only close fee)
    // longA: collateral 20k, notional 120k
    const baseLongGross = toUSDC(20_000n)
    const baseLongFee   = (baseLongGross * 10n) / 10_000n
    const baseLongNet   = baseLongGross - baseLongFee
    // shortB: collateral 10k, notional 30k
    const baseShortGross = toUSDC(10_000n)
    const baseShortFee   = (baseShortGross * 10n) / 10_000n
    const baseShortNet   = baseShortGross - baseShortFee

    const longActualNet  = userALEnd - userALStart
    const shortActualNet = userBSEnd - userBSStart

    console.log("baseLongFee: ", baseLongFee);
    console.log("baseShortFee: ", baseShortFee);
    console.log("longActualNet: ", longActualNet);
    console.log("shortActualNet: ", shortActualNet);
    console.log("baseLongNet: ", baseLongNet);
    console.log("baseShortNet: ", baseShortNet);

    // positive rate: long <= baseline, short >= baseline
    expect(longActualNet <= baseLongNet).to.eq(true)
    expect(shortActualNet >= baseShortNet).to.eq(true)
  })

  it('zero price move with mixed sizes: payer reduced more with larger size; receiver increased more with larger size', async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(3_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(3_000_000n))

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(500_000n))
      await usdc.connect(u).approve(perpsAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u))
    }

    // Make positive rate (long>short)
    {
      // A: big long, B: small short
      const [eL] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(200_000n))]))
      await perps.connect(userA).openPosition(true, eL, toUSDC(30_000n), 0, 0)
      const [eS] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(40_000n))]))
      await perps.connect(userB).openPosition(false, eS, toUSDC(10_000n), 0, 0)

      const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
      await perps.requestFundingRateFromSkew()
      const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await perps.commitFundingRate(epoch)
      const rate = BigInt(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true)
    }

    // Accrue with zero price move
    await feed.updateAnswer(price(2000n))
    await time.increase(12 * 3600)
    await perps.pokeFunding()

    // Close both
    const longStart = BigInt(await usdc.balanceOf(userA.address))
    await perps.connect(userA).closePosition(1)
    await coprocessor()
    await perps.settlePositions([1])
    const longEnd = BigInt(await usdc.balanceOf(userA.address))

    const shortStart = BigInt(await usdc.balanceOf(userB.address))
    await perps.connect(userB).closePosition(2)
    await coprocessor()
    await perps.settlePositions([2])
    const shortEnd = BigInt(await usdc.balanceOf(userB.address))

    // Baselines (no price change) net of close fee
    const baseLongGross = toUSDC(30_000n)
    const baseLongNet   = baseLongGross - (baseLongGross * 10n) / 10_000n
    const baseShortGross= toUSDC(10_000n)
    const baseShortNet  = baseShortGross - (baseShortGross * 10n) / 10_000n

    const longActualNet  = longEnd  - longStart
    const shortActualNet = shortEnd - shortStart

    // Long (payer) below baseline; Short (receiver) above baseline
    expect(longActualNet <= baseLongNet).to.eq(true)
    expect(shortActualNet >= baseShortNet).to.eq(true)
  })

  // -------------------------------------------------------
  // 4) Open/close within one epoch: tiny dF sign & snapshot
  // -------------------------------------------------------
  it('tiny accrual after commit: dF sign matches rate (no flip) for long payer', async function () {
    const { perps, perpsAddr, usdc, userA, lp } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

    await usdc.mint(userA.address, toUSDC(200_000n))
    await usdc.connect(userA).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userA))

    // Make positive rate
    {
      const [eL] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(100_000n))]))
      await perps.connect(userA).openPosition(true, eL, toUSDC(20_000n), 0, 0)
      const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
      await perps.requestFundingRateFromSkew()
      const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await perps.commitFundingRate(epoch)
      const rate = BigInt(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true)
    }

    // Open a small long after commit
    const coll = toUSDC(10_000n)
    const notional = toUSDC(30_000n)
    const [eSz] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(notional)]))
    await perps.connect(userA).openPosition(true, eSz, coll, 0, 0)

    // Very small accrual
    await time.increase(5) // 5 seconds
    await perps.pokeFunding()

    // Close at same price
    const startBal = BigInt(await usdc.balanceOf(userA.address))
    await perps.connect(userA).closePosition(2)
    await coprocessor()
    await perps.settlePositions([2])
    const endBal = BigInt(await usdc.balanceOf(userA.address))

    // Baseline net (no price move)
    const baseGross = coll
    const baseNet   = baseGross - (baseGross * 10n)/10_000n

    const actualNet = endBal - startBal

    // With positive rate and tiny dt, long should pay a tiny amount: actual <= baseline, not negative flip
    expect(actualNet <= baseNet).to.eq(true)
    // And the difference should be small (<= few units) — loose check to ensure no crazy flip
    expect(baseNet - actualNet < toUSDC(1n)).to.eq(true)
  })

  it.only('open just before vs just after commit: earlier entry incurs >= funding than later entry (same duration after later entry)', async function () {
    const { perps, perpsAddr, usdc, userA, userB, lp } = await loadFixture(deployFixture)
  
    await usdc.mint(lp.address, toUSDC(3_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(3_000_000n))
  
    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(400_000n))
      await usdc.connect(u).approve(perpsAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u))
    }
  
    // Make positive rate: long>short
    {
      const [eL] = await hre.cofhe.expectResultSuccess(
        cofhejs.encrypt([Encryptable.uint256(toUSDC(150_000n))])
      )
      await perps.connect(userA).openPosition(true, eL, toUSDC(20_000n), 0, 0)
      const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
      await perps.requestFundingRateFromSkew()
      const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await perps.commitFundingRate(epoch)
      const rate = BigInt(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true) // longs pay
    }
  
    // (Optional) neutralize skew to reduce entry-impact noise:
    // const [eShortNeutral] = await hre.cofhe.expectResultSuccess(
    //   cofhejs.encrypt([Encryptable.uint256(toUSDC(150_000n))])
    // )
    // await perps.connect(userB).openPosition(false, eShortNeutral, toUSDC(25_000n), 0, 0)
  
    // A opens just BEFORE next commit
    const collA = toUSDC(10_000n)
    const notionalA = toUSDC(30_000n)
    const [eA] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalA)])
    )
    await perps.connect(userA).openPosition(true, eA, collA, 0, 0)
    const entryFundingA = BigInt((await perps.getPosition(2)).entryFundingX18)
  
    // Immediately flip epoch (commit accrues up to now with old rate)
    {
      const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
      await perps.requestFundingRateFromSkew()
      const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
      await coprocessor()
      await perps.commitFundingRate(epoch)
    }
  
    // B opens just AFTER the commit
    const collB = toUSDC(10_000n)
    const notionalB = toUSDC(30_000n)
    const [eB] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalB)])
    )
    await perps.connect(userB).openPosition(true, eB, collB, 0, 0)
    const entryFundingB = BigInt((await perps.getPosition(3)).entryFundingX18)
  
    // Accrue same duration for both after B’s entry
    await time.increase(60)
    await perps.pokeFunding() // freeze indices for measurement
  
    // === Direct funding delta check (isolated from impact/fees) ===
    const cumLong = BigInt(await perps.cumFundingLongX18())
    const dFA = cumLong - entryFundingA
    const dFB = cumLong - entryFundingB
    expect(dFA >= dFB).to.eq(true) // earlier A should have >= funding accrued than B
  
    // === (Optional) payout ordering, but allow generous slack because of entry impact ===
    const aStart = BigInt(await usdc.balanceOf(userA.address))
    await perps.connect(userA).closePosition(2)
    await coprocessor()
    await perps.settlePositions([2])
    const aEnd = BigInt(await usdc.balanceOf(userA.address))
  
    const bStart = BigInt(await usdc.balanceOf(userB.address))
    await perps.connect(userB).closePosition(3)
    await coprocessor()
    await perps.settlePositions([3])
    const bEnd = BigInt(await usdc.balanceOf(userB.address))
  
    const baseGrossA = collA; const baseNetA = baseGrossA - (baseGrossA * 10n)/10_000n
    const baseGrossB = collB; const baseNetB = baseGrossB - (baseGrossB * 10n)/10_000n
    const actualNetA = aEnd - aStart
    const actualNetB = bEnd - bStart
  
    // Both longs under positive rate should be ≤ baseline; ordering can be skewed by entry impact
    expect(actualNetA <= baseNetA).to.eq(true)
    expect(actualNetB <= baseNetB).to.eq(true)
  
    // TODO assert payout ordering:
    //  - enable the "neutralize skew" block above, or
    //  - reduce notionalA/notionalB to MIN_NOTIONAL_USDC to minimize impact, or
    //  - use a large EPS to tolerate impact difference.
  }).timeout(120000);
})
