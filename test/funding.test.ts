// test/funding.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'
import { expect } from 'chai'

function toUSDC(n: bigint) { return n * 10n ** 6n }    // 6 decimals
function price(n: bigint)  { return n * 10n ** 8n }    // 8 decimals
const ONE_X18 = 10n ** 18n
const CLOSE_FEE_BPS = 10n // 0.1%

// CoFHE decrypts async
function coprocessor(ms = 10_000) {
  console.log("waiting for coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}

async function cofheUnsealEint256(e : any) {
    const val = await cofhejs.unseal(e.val, FheTypes.Uint256);
    const sign = await cofhejs.unseal(e.sign, FheTypes.Bool);
    
    const v = (val.data == null) ? 0 : val.data;

    // make value negative if sign is false
    const result = BigInt(!sign.data ? -1 : 1) * BigInt(v);
    console.log("result: ", result);
    return result;
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

// Baseline (no price change, no funding) payout net: collateral - close fee
function baselineNetPayoutBasic(collateral: bigint): bigint {
  const fee = (collateral * CLOSE_FEE_BPS) / 10_000n
  return collateral - fee
}

describe('Endex — Funding Fees', function () {
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
    const Perps = await hre.ethers.getContractFactory('EndexHarness')
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
    // tuples: [longNotional, shortNotional]
    const cases: Array<[bigint, bigint]> = [
      [toUSDC(50_000n), toUSDC(10_000n)],   // long > short => rate > 0
      [toUSDC(90_000n), toUSDC(150_000n)],  // long < short => rate < 0
      [toUSDC(100_000n), toUSDC(100_000n)], // long == short => rate ≈ 0
      [toUSDC(10_000n), toUSDC(500_000n)],  // fuzz: strong negative skew => rate < 0
      [toUSDC(400_000n), toUSDC(5_000n)],   // fuzz: strong positive skew => rate > 0
    ]

    for (const [Long, Short] of cases) {
      // Open positions fresh each iteration (use new fixture to isolate OI) for clean skew
      let { perps, perpsAddr, usdc, userA: user, lp } = await loadFixture(deployFixture)

      await usdc.mint(lp.address, toUSDC(2_000_000n))
      await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
      await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

      await usdc.mint(user.address, toUSDC(800_000n))
      await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

      const [eL] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(Long)]))
      await perps.connect(user).openPosition(true, eL, toUSDC(20_000n))

      const [eS] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(Short)]))
      await perps.connect(user).openPosition(false, eS, toUSDC(20_000n))

      await coprocessor()

      const rateX18 = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
      if (Long > Short) expect(rateX18 > 0n).to.eq(true)          // positive skew → rate > 0
      else if (Long < Short) expect(rateX18 < 0n).to.eq(true)     // negative skew → rate < 0
      else expect(rateX18 === 0n).to.eq(true)              // equal skew → ~0 (within mocks, exactly 0)
    }
  }).timeout(120000);

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
      await perps.connect(userA).openPosition(true, eL, toUSDC(20_000n))
      const [eS] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(30_000n))]))
      await perps.connect(userB).openPosition(false, eS, toUSDC(10_000n))

      await coprocessor()
      const rate = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
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
      await perps.connect(userA).openPosition(true, eL, toUSDC(30_000n))
      const [eS] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(40_000n))]))
      await perps.connect(userB).openPosition(false, eS, toUSDC(10_000n))

      await coprocessor()
      const rate = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
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

  it('tiny accrual after commit: dF sign matches rate (no flip) for long payer', async function () {
    const { perps, perpsAddr, usdc, userA: user, lp } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

    await usdc.mint(user.address, toUSDC(200_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // Make positive rate
    {
      const [eL] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(toUSDC(100_000n))]))
      await perps.connect(user).openPosition(true, eL, toUSDC(20_000n))
      await coprocessor()
      const rate = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true)
    }

    // Open a small long after commit
    const coll = toUSDC(10_000n)
    const notional = toUSDC(30_000n)
    const [eSz] = await hre.cofhe.expectResultSuccess(cofhejs.encrypt([Encryptable.uint256(notional)]))
    await perps.connect(user).openPosition(true, eSz, coll)

    // Very small accrual
    await time.increase(5) // 5 seconds
    await perps.pokeFunding()

    // Close at same price
    const startBal = BigInt(await usdc.balanceOf(user.address))
    await perps.connect(user).closePosition(2)
    await coprocessor()
    await perps.settlePositions([2])
    const endBal = BigInt(await usdc.balanceOf(user.address))

    // Baseline net (no price move)
    const baseGross = coll
    const baseNet   = baseGross - (baseGross * 10n)/10_000n

    const actualNet = endBal - startBal

    // With positive rate and tiny dt, long should pay a tiny amount: actual <= baseline, not negative flip
    expect(actualNet <= baseNet).to.eq(true)
    // And the difference should be small (<= few units) — loose check to ensure no crazy flip
    expect(baseNet - actualNet < toUSDC(1n)).to.eq(true)
  })

  it('two consecutuve positions: earlier entry incurs >= funding than later entry (same duration after later entry)', async function () {
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
      await perps.connect(userA).openPosition(true, eL, toUSDC(20_000n))
      await coprocessor()
      const rate = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true) // longs pay
    }
  
    // A opens
    const collA = toUSDC(10_000n)
    const notionalA = toUSDC(30_000n)
    const [eA] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalA)])
    )
    await perps.connect(userA).openPosition(true, eA, collA)
    const entryFundingA = await cofheUnsealEint256((await perps.getPosition(2)).entryFundingX18)
  
    await coprocessor()
  
    // B opens
    const collB = toUSDC(10_000n)
    const notionalB = toUSDC(30_000n)
    const [eB] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalB)])
    )
    await perps.connect(userB).openPosition(true, eB, collB)
    const entryFundingB = await cofheUnsealEint256((await perps.getPosition(3)).entryFundingX18)
  
    // Accrue same duration for both after B’s entry
    await time.increase(60)
    await perps.pokeFunding() // freeze indices for measurement
  
    // === Direct funding delta check (isolated from impact/fees) ===
    const cumLong = await cofheUnsealEint256(await perps.cumFundingLongX18())
    const dFA = cumLong - entryFundingA
    const dFB = cumLong - entryFundingB
    expect(dFA >= dFB).to.eq(true) // earlier A should have >= funding accrued than B
  }).timeout(120000);


  it('funding flows from larger long to smaller short (zero price move)', async function () {
    const { perps, perpsAddr, usdc, feed, userA: longUser, userB: shortUser, lp } = await loadFixture(deployFixture)

    // LP capital
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

    // Fund users
    await usdc.mint(longUser.address,  toUSDC(500_000n))
    await usdc.mint(shortUser.address, toUSDC(500_000n))
    await usdc.connect(longUser).approve(perpsAddr, hre.ethers.MaxUint256)
    await usdc.connect(shortUser).approve(perpsAddr, hre.ethers.MaxUint256)

    // Init CoFHE (per user)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(longUser))
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(shortUser))

    // Open LONG (bigger notional) => positive skew
    const L_coll = toUSDC(50_000n)
    const L_not  = toUSDC(200_000n) // 4x long
    const [L_enc] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(L_not)])
    )
    const priceEntry = price(2000n)
    await feed.updateAnswer(priceEntry)

    const longStartBal = BigInt(await usdc.balanceOf(longUser.address))
    await perps.connect(longUser).openPosition(
      true, // isLong
      L_enc,
      L_coll,
      0, // stopLoss (plaintext for now)
      0  // takeProfit (plaintext for now)
    )

    // Open SHORT (smaller notional)
    const S_coll = toUSDC(40_000n)
    const S_not  = toUSDC(100_000n) // 2.5x short — smaller than long notional
    const [S_enc] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(S_not)])
    )
    const shortStartBal = BigInt(await usdc.balanceOf(shortUser.address))
    await perps.connect(shortUser).openPosition(
      false, // isLong
      S_enc,
      S_coll,
      0,
      0
    )

    // === Funding from skew (async request → commit) ===
    await coprocessor()

    // Expect positive funding rate (longs pay, shorts receive)
    const rateX18 = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
    expect(rateX18 > 0n).to.eq(true)

    // Accrue funding over 8 hours
    await time.increase(8 * 3600)
    await perps.pokeFunding()

    // Keep price unchanged to isolate funding
    await feed.updateAnswer(priceEntry)

    // === Close both
    await perps.connect(longUser).closePosition(1)  // requests size decrypt
    await perps.connect(shortUser).closePosition(2)
    await coprocessor()
    await perps.settlePositions([1, 2])

    // Final balances
    const longEndBal  = BigInt(await usdc.balanceOf(longUser.address))
    const shortEndBal = BigInt(await usdc.balanceOf(shortUser.address))

    // Baselines (no funding, zero PnL)
    const longBaselineEnd  = longStartBal  - L_coll + baselineNetPayoutBasic(L_coll)
    const shortBaselineEnd = shortStartBal - S_coll + baselineNetPayoutBasic(S_coll)

    // Assertions: long paid funding (<= baseline), short received funding (>= baseline)
    expect(longEndBal  <= longBaselineEnd).to.eq(true)
    expect(shortEndBal >= shortBaselineEnd).to.eq(true)

    // show magnitudes for debugging
    console.log('Δlong vs baseline:', (longEndBal - longBaselineEnd).toString())
    console.log('Δshort vs baseline:', (shortEndBal - shortBaselineEnd).toString())
  })

  it('accrues funding via async request/commit and charges it only at settlement', async function () {
    const { perps, perpsAddr, usdc, feed, userA: user, lp } = await loadFixture(deployFixture)

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

    console.log("openPosition..")
    await perps.connect(user).openPosition(
      true, encSize, collateral
    )
    console.log("done..")

    let pos = await perps.getPosition(1)
    expect(pos.status).to.equal(0) // Open
    expect(pos.entryPrice).to.equal(price(2000n))

    // Advance time and accrue with current rate
    const dt = 24 * 3600 // 1 day
    await time.increase(dt)
    await perps.pokeFunding()

    // Check cumulative vs entry snapshot (for settlement math)
    //const cumLong = BigInt(await perps.cumFundingLongX18())
    //const entryFunding = BigInt((await perps.getPosition(1)).entryFundingX18)
    //const fundingDeltaX18 = cumLong - entryFunding

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
  // Funding sign sanity (shorts dominate)
  // -----------------------------
  it('commits negative funding rate when shorts dominate (no underflow on |skew|)', async function () {
    const { perps, perpsAddr, usdc, userA: user, lp } = await loadFixture(deployFixture)

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
    await perps.connect(user).openPosition(false, encSize, collateral)

    await coprocessor()
    
    const rateX18 = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
    expect(rateX18 < 0n).to.be.true // negative funding ⇒ correct sign

    // Advance time and accrue to ensure indices move in the expected directions
    await time.increase(6 * 3600) // 6 hours
    const beforeLong = (await cofheUnsealEint256(await perps.cumFundingLongX18()));
    const beforeShort = (await cofheUnsealEint256(await perps.cumFundingShortX18()));
    await perps.pokeFunding()
    const afterLong = (await cofheUnsealEint256(await perps.cumFundingLongX18()));
    const afterShort = (await cofheUnsealEint256(await perps.cumFundingShortX18()));

    // With negative rate: cumFundingLong decreases, cumFundingShort increases
    expect(afterLong < beforeLong).to.be.true
    expect(afterShort > beforeShort).to.be.true
  })
})
