// test/funding.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { expect } from 'chai'
import {_deployFixture, baselineNetPayout, baselineNetPayoutBasic, coprocessor, encryptBool, encryptUint256, openPosition, parseStatus, price, PX0, toUSDC, unsealEint256, unsealEuint256} from './utils'

describe('Endex — Funding Fees', function () {
  async function deployFixture() {
    return (await _deployFixture());
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    //hre.cofhe.mocks.enableLogs()
  })

  it('funding sign tracks skew (long>short → rate>0, short>long → rate<0), across multiple magnitudes', async function () {
    // tuples: [longNotional, shortNotional]
    const cases: Array<[bigint, bigint]> = [
      [toUSDC(50_000n), toUSDC(10_000n)],   // long > short => rate > 0
      [toUSDC(90_000n), toUSDC(100_000n)],  // long < short => rate < 0
      [toUSDC(100_000n), toUSDC(100_000n)], // long == short => rate ≈ 0
      [toUSDC(10_000n), toUSDC(100_000n)],  // fuzz: strong negative skew => rate < 0
      [toUSDC(100_000n), toUSDC(5_000n)],   // fuzz: strong positive skew => rate > 0
    ]

    for (const [Long, Short] of cases) {
      // Open positions fresh each iteration (use new fixture to isolate OI) for clean skew
      let { perps, perpsAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

      await usdc.mint(lp.address, toUSDC(2_000_000n))
      await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
      await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

      await usdc.mint(user.address, toUSDC(800_000n))
      await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))
      console.log("\nLong:", Long);
      console.log("Short:", Short);
      const edL = await encryptBool(true);
      const enL = await encryptUint256(Long);
      await openPosition(perps, keeper, user, edL, enL, toUSDC(20_000n))

      const edS = await encryptBool(false);
      const enS = await encryptUint256(Short);
      await openPosition(perps, keeper, user, edS, enS, toUSDC(20_000n))

      const rateX18 = await unsealEint256(await perps.fundingRatePerSecX18())
      const longOI = await unsealEuint256(await perps.encLongOI())
      const shortOI = await unsealEuint256(await perps.encShortOI())
      console.log(rateX18);
      console.log(longOI);
      console.log(shortOI);

      if (Long > Short) expect(rateX18 > 0n).to.eq(true)          // positive skew → rate > 0
      else if (Long < Short) expect(rateX18 < 0n).to.eq(true)     // negative skew → rate < 0
      else expect(rateX18 === 0n).to.eq(true)              // equal skew → ~0 (within mocks, exactly 0)
    }
  }).timeout(360000);

  it('zero price move: positive rate → long <= baseline, short >= baseline (mirror)', async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp, keeper } = await loadFixture(deployFixture)

    // Pool & users
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))
    await feed.updateAnswer(PX0)

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(300_000n))
      await usdc.connect(u).approve(perpsAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u))
    }

    // Create positive rate (long>short)
    {
      const edL = await encryptBool(true)
      const enL = await encryptUint256(toUSDC(120_000n))
      await openPosition(perps, keeper, userA, edL, enL, toUSDC(24_000n))

      const edS = await encryptBool(false)
      const enS = await encryptUint256(toUSDC(30_000n));
      await openPosition(perps, keeper, userB, edS, enS, toUSDC(10_000n))

      const rate = await unsealEint256(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true)
    }

    // Zero price change, accrue funding
    await time.increase(6 * 3600)
    await perps.pokeFunding()

    // Close long (payer) and short (receiver)
    const userALStart = BigInt(await usdc.balanceOf(userA.address))
    console.log("first close position..");
    await perps.connect(userA).closePosition(1)
    await coprocessor()
    await perps.connect(keeper).process([1])
    const userALEnd = BigInt(await usdc.balanceOf(userA.address))

    const userBSStart = BigInt(await usdc.balanceOf(userB.address))
    console.log("second close position..");
    await perps.connect(userB).closePosition(2)
    await coprocessor()
    await perps.connect(keeper).process([2])
    const userBSEnd = BigInt(await usdc.balanceOf(userB.address))

    // Baseline (no price change, only close fee)
    // longA: collateral 24k, notional 120k
    const baseLongGross = toUSDC(24_000n)
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
  }).timeout(120000);

  it('zero price move with mixed sizes: payer reduced more with larger size; receiver increased more with larger size', async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp, keeper } = await loadFixture(deployFixture)

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
      const edL = await encryptBool(true)
      const enL = await encryptUint256(toUSDC(200_000n))
      await openPosition(perps, keeper, userA, edL, enL, toUSDC(40_000n))
      const edS = await encryptBool(false)
      const enS = await encryptUint256(toUSDC(40_000n))
      await openPosition(perps, keeper, userB, edS, enS, toUSDC(10_000n))

      const rate = await unsealEint256(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true)
    }

    // Accrue with zero price move
    await feed.updateAnswer(PX0)
    await time.increase(12 * 3600)
    await perps.pokeFunding()

    // Close both
    const longStart = BigInt(await usdc.balanceOf(userA.address))
    await perps.connect(userA).closePosition(1)
    await coprocessor()
    await perps.connect(keeper).process([1])
    const longEnd = BigInt(await usdc.balanceOf(userA.address))

    const shortStart = BigInt(await usdc.balanceOf(userB.address))
    await perps.connect(userB).closePosition(2)
    await coprocessor()
    await perps.connect(keeper).process([2])
    const shortEnd = BigInt(await usdc.balanceOf(userB.address))

    // Baselines (no price change) net of close fee
    const baseLongGross = toUSDC(40_000n)
    const baseLongNet   = baseLongGross - (baseLongGross * 10n) / 10_000n
    const baseShortGross= toUSDC(10_000n)
    const baseShortNet  = baseShortGross - (baseShortGross * 10n) / 10_000n

    const longActualNet  = longEnd  - longStart
    const shortActualNet = shortEnd - shortStart

    // Long (payer) below baseline; Short (receiver) above baseline
    expect(longActualNet <= baseLongNet).to.eq(true)
    expect(shortActualNet >= baseShortNet).to.eq(true)
  }).timeout(120000);

  it('tiny accrual after commit: dF sign matches rate (no flip) for long payer', async function () {
    const { perps, perpsAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))

    await usdc.mint(user.address, toUSDC(200_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // Make positive rate
    {
      const edL = await encryptBool(true)
      const enL = await encryptUint256(toUSDC(100_000n))
      await openPosition(perps, keeper, user, edL, enL, toUSDC(20_000n))
      const rate = await unsealEint256(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true)
    }

    // Open a small long after commit
    const coll = toUSDC(10_000n)
    const direction = true
    const notional = toUSDC(30_000n)
    const eD = await encryptBool(direction)
    const eS = await encryptUint256(notional)
    await openPosition(perps, keeper, user, eD, eS, coll)

    // Very small accrual
    await time.increase(5) // 5 seconds
    await perps.pokeFunding()

    // Close at same price
    const startBal = BigInt(await usdc.balanceOf(user.address))
    await perps.connect(user).closePosition(2)
    await coprocessor()
    await perps.connect(keeper).process([2])
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
    const { perps, perpsAddr, usdc, userA, userB, lp, keeper } = await loadFixture(deployFixture)
  
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
      const edL = await encryptBool(true)
      const enL = await encryptUint256(toUSDC(150_000n))
      await openPosition(perps, keeper, userA, edL, enL, toUSDC(30_000n))
      const rate = await unsealEint256(await perps.fundingRatePerSecX18())
      expect(rate > 0n).to.eq(true) // longs pay
    }
  
    // A opens
    const collA = toUSDC(10_000n)
    const notionalA = toUSDC(30_000n)
    const directionA = true;
    const edA = await encryptBool(directionA)
    const enA = await encryptUint256(notionalA)
    await openPosition(perps, keeper, userA, edA, enA, collA)
    const entryFundingA = await unsealEint256((await perps.getPosition(2)).entryFundingX18)
  
    // B opens
    const collB = toUSDC(10_000n)
    const notionalB = toUSDC(30_000n)
    const directionB = true;
    const edB = await encryptBool(directionB)
    const enB = await encryptUint256(notionalB)
    await openPosition(perps, keeper, userB, edB, enB, collB)
    const entryFundingB = await unsealEint256((await perps.getPosition(3)).entryFundingX18)
  
    // Accrue same duration for both after B’s entry
    await time.increase(60)
    await perps.pokeFunding() // freeze indices for measurement
  
    // === Direct funding delta check (isolated from impact/fees) ===
    const cumLong = await unsealEint256(await perps.cumFundingLongX18())
    const dFA = cumLong - entryFundingA
    const dFB = cumLong - entryFundingB
    expect(dFA >= dFB).to.eq(true) // earlier A should have >= funding accrued than B
  }).timeout(120000);


  it('funding flows from larger long to smaller short (zero price move)', async function () {
    const { perps, perpsAddr, usdc, feed, userA: longUser, userB: shortUser, lp, keeper } = await loadFixture(deployFixture)

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
    const L_dir  = true
    const Ld_enc = await encryptBool(L_dir)
    const Ln_enc = await encryptUint256(L_not)
    const priceEntry = PX0
    await feed.updateAnswer(priceEntry)

    const longStartBal = BigInt(await usdc.balanceOf(longUser.address))
    await openPosition(perps, keeper, longUser, Ld_enc, Ln_enc, L_coll);

    // Open SHORT (smaller notional)
    const S_coll = toUSDC(40_000n)
    const S_not  = toUSDC(100_000n) // 2.5x short — smaller than long notional
    const S_dir  = false // short
    const Sd_enc = await encryptBool(S_dir)
    const Sn_enc = await encryptUint256(S_not)
    const shortStartBal = BigInt(await usdc.balanceOf(shortUser.address))
    await openPosition(perps, keeper, shortUser, Sd_enc, Sn_enc, S_coll);

    // Expect positive funding rate (longs pay, shorts receive)
    const rateX18 = await unsealEint256(await perps.fundingRatePerSecX18())
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
    await perps.connect(keeper).process([1, 2])

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
    const { perps, perpsAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture)

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
    const direction  = true
    const encDirection = await encryptBool(direction)
    const encSize = await encryptUint256(notional)

    const userBalStart = BigInt(await usdc.balanceOf(user.address))

    await openPosition(perps, keeper, user, encDirection, encSize, collateral)

    let pos = await perps.getPosition(1)
    expect(parseStatus(pos.status)).to.equal("Open") // Open
    expect(pos.entryPrice).to.equal(PX0)

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
    expect(parseStatus(pos.status)).to.equal("Awaiting Settlement")

    // Wait for size decrypt
    await coprocessor()

    // Settle
    await perps.connect(keeper).process([1])
    pos = await perps.getPosition(1)
    let status = parseStatus(pos.status);
    expect(["Closed", "Liquidated"]).to.include(status) // Closed or (edge) Liquidated

    // Verify settlement-only effect on user balance — actual must be <= baseline (impact + possibly negative funding)
    const userBalEnd = BigInt(await usdc.balanceOf(user.address))

    // Baseline (no impact, funding=observed sign) — here we build baseline ignoring impact only,
    // but we know impact never *increases* payout for a first long (skew>=0 at entry).
    const baseNoImpact = baselineNetPayout(
      collateral, notional, PX0, price(2100n), 10n
    )
    const expectedMaxEnd = userBalStart - collateral + baseNoImpact

    expect(userBalEnd <= expectedMaxEnd).to.eq(true)
  })

  // -----------------------------
  // Funding sign sanity (shorts dominate)
  // -----------------------------
  it.only('commits negative funding rate when shorts dominate (no underflow on |skew|)', async function () {
    const { perps, perpsAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

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
    const direction  = false // short
    const encDirection = await encryptBool(direction);
    const encSize = await encryptUint256(notional)
    await openPosition(perps, keeper, user, encDirection, encSize, collateral)

    const rateX18 = await unsealEint256(await perps.fundingRatePerSecX18())
    expect(rateX18 < 0n).to.be.true // negative funding ⇒ correct sign

    // Advance time and accrue to ensure indices move in the expected directions
    await time.increase(6 * 3600) // 6 hours
    const beforeLong  = await unsealEint256(await perps.cumFundingLongX18());
    const beforeShort = await unsealEint256(await perps.cumFundingShortX18());
    
    await perps.pokeFunding();
    
    const afterLong   = await unsealEint256(await perps.cumFundingLongX18());
    const afterShort  = await unsealEint256(await perps.cumFundingShortX18());
    const longOI      = await unsealEuint256(await perps.encLongOI());
    
    // Negative rate sanity (shorts dominate)
    expect(rateX18 < 0n).to.be.true;
    
    // Short index must increase (shorts are payers, dF.sign=true → loss bucket)
    expect(afterShort > beforeShort).to.be.true;
    
    // Long index:
    // - If no longs exist, it may remain unchanged (scaled bump = 0).
    // - If some longs exist, it should decrease (receiver index moves opposite payer).
    if (longOI === 0n) {
      expect(afterLong).to.equal(beforeLong);
    } else {
      expect(afterLong < beforeLong).to.be.true;
}
  })
})
