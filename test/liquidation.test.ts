// test/liquidation.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { expect } from 'chai'

import {
    _deployFixture, 
    coprocessor, 
    encryptBool, 
    encryptUint256, 
    ONE_X18, 
    openPosition, 
    parseStatus, 
    price, 
    toUnderlying, 
    decryptEint256
} from './utils'

describe('Endex — Liquidation', function () {
  async function deployFixture() {
    return (await _deployFixture());
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    //hre.cofhe.mocks.enableLogs() // enable for CoFHE operation logs
  })

  it('performs encrypted liquidation via request → finalize → settle', async function () {
    const { endex, endexAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUnderlying(1_000_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(1_000_000n))

    await usdc.mint(user.address, toUnderlying(30_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // 4x long likely to liquidate on large drop
    const collateral = toUnderlying(5_000n)
    const direction = await encryptBool(true);
    const size = await encryptUint256(toUnderlying(20_000n))

    await openPosition({ endex, keeper, user, direction, size, collateral })

    // Big drop to force liquidation
    await feed.updateAnswer(price(1500n))

    // Step 1: request liquidation checks (starts decrypts)
    await endex.connect(keeper).process([1])
    await coprocessor()

    // Step 2: finalize; should pass liquidatable check and move to Awaiting Settlement
    await endex.connect(keeper).process([1])
    let pos = await endex.getPosition(1)
    expect(parseStatus(pos.status)).to.equal("Awaiting Settlement")

    // Wait for size decrypt triggered in setup
    await coprocessor()

    // Settle; expect Liquidated
    await endex.connect(keeper).process([1])
    pos = await endex.getPosition(1)
    expect(parseStatus(pos.status)).to.equal("Liquidated")
  })

  // -----------------------------
  // Negative intermediaries guard
  // -----------------------------
  it('handles deep negative price PnL without underflow', async function () {
    const { endex, endexAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUnderlying(1_000_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(1_000_000n))

    await usdc.mint(user.address, toUnderlying(30_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const collateral = toUnderlying(5_000n)
    const direction = await encryptBool(true);
    const size = await encryptUint256(toUnderlying(20_000n));

    await openPosition({ endex, keeper, user, direction, size, collateral })

    // ~50% drop (2000 -> 1000) would make (ratio - 1) negative if naive; our buckets avoid underflow
    await feed.updateAnswer(price(1000n))

    // Step 1: request liquidation checks (starts decrypts)
    await endex.connect(keeper).process([1])
    await coprocessor()

    // Step 2: finalize; should pass liquidatable check and move to Awaiting Settlement
    await endex.connect(keeper).process([1])
    await coprocessor()

    let pos = await endex.getPosition(1)
    expect(parseStatus(pos.status)).to.equal("Awaiting Settlement") // Awaiting Settlement — compare succeeded, no underflow

    // Settle; expect Liquidated
    await endex.connect(keeper).process([1])
    pos = await endex.getPosition(1)
    expect(parseStatus(pos.status)).to.equal("Liquidated")
  })

  // --------------------------------------------
  // 2) Liquidations include funding at settlement
  // --------------------------------------------
  it('liquidated LONG under positive rate explicitly pays funding (actual ≈ baseline - size*dF/1e18)', async function () {
    const { endex, endexAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture)
  
    // Pool & user
    await usdc.mint(lp.address, toUnderlying(2_000_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n))
  
    await usdc.mint(user.address, toUnderlying(200_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))
  
    // 1) Ensure POSITIVE rate: open a large LONG to bias skew => longs pay
    {
      const direction = await encryptBool(true);
      const size = await encryptUint256(toUnderlying(120_000n));
      
      await openPosition({ endex, keeper, user, direction, size, collateral: toUnderlying(24_000n) })
  
      const r = await decryptEint256(await endex.fundingRatePerSecond())
      expect(r > 0n, 'expected positive funding rate (longs pay)').to.eq(true)
    }
  
    // 2) Open a 5x LONG we will liquidate with small *positive* equity at liq price
    const collateralL = toUnderlying(5_000n)
    const directionL  = true
    const sizeL  = toUnderlying(25_000n) // 5x
    const encDirectionL = await encryptBool(directionL);
    const encSizeL = await encryptUint256(sizeL);
    await openPosition({ endex, keeper, user, direction: encDirectionL, size: encSizeL, collateral: collateralL })
  
    // Accrue funding meaningfully
    await time.increase(3 * 24 * 3600) // 3 days
    await endex.updateFunding()
  
    // Price low enough to liquidate, but still equity > 0 (baseline)
    // Entry 2000 → at 1619: pnl = 25k * (1619-2000)/2000 = -4,762.5 → equity ~ 237.5 > 0
    await feed.updateAnswer(price(1619n))
  
    // Snapshot funding delta for this position (id = 2)
    const pos2_before = await endex.getPosition(2)
    const cumLong = await decryptEint256(await endex.cumFundingLong())
    const entryFunding2 = await decryptEint256(pos2_before.entryFunding)
    let dF = cumLong - entryFunding2
    expect(dF > 0n, 'dF should be positive for longs when rate>0').to.eq(true)
  
    // Liquidation flow
    // Step 1: request liquidation checks (starts decrypts)
    await endex.connect(keeper).process([2])
    await coprocessor()
    // Step 2: finalize; should pass liquidatable check and move to Awaiting Settlement
    await endex.connect(keeper).process([2])
    await coprocessor()
  
    // Optional: avoid accrual drift
    await endex.updateFunding()
  
    // Settle and observe actual transfer
    const userStart = BigInt(await usdc.balanceOf(user.address))
    // Settle; expect Liquidated
    await endex.connect(keeper).process([2])
    const userEnd = BigInt(await usdc.balanceOf(user.address))
    const actualPayout = userEnd - userStart
  
    // --- Compute baselines ---
    // Baseline w/o funding (PnL only)
    const pnl = (sizeL * (1619n - 2000n)) / 2000n // negative
    let grossBaseline = collateralL + pnl
    if (grossBaseline < 0n) grossBaseline = 0n
    const feeBaseline = (grossBaseline * 10n) / 10_000n // CLOSE_FEE_BPS = 10
    const netBaseline = grossBaseline - feeBaseline
  
    // With funding: grossWithF = max(0, collateral + pnl - size * dF / 1e18)
    let fundingUSDC = (sizeL * dF) / ONE_X18
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
  }).timeout(120000);

  it('liquidated SHORT under negative rate explicitly pays funding (actual ≈ baseline - size*dF/1e18)', async function () {
    const { endex, endexAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture)
  
    // Pool & user
    await usdc.mint(lp.address, toUnderlying(2_000_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n))
  
    await usdc.mint(user.address, toUnderlying(200_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))
  
    // Ensure NEGATIVE rate: open a large SHORT only to bias skew (shorts pay)
    {
      const direction = await encryptBool(false);
      const size = await encryptUint256(toUnderlying(150_000n))
      await openPosition({ endex, keeper, user, direction, size, collateral: toUnderlying(30_000n) })
      const rate = await decryptEint256(await endex.fundingRatePerSecond())
      expect(rate < 0n, 'expected negative funding rate (shorts pay)').to.eq(true)
    }
  
    // Open the HIGH-LEV SHORT we will liquidate
    const collateralS = toUnderlying(6_000n)
    const directionS  = false
    const sizeS  = toUnderlying(30_000n) // 5x
    const encDirectionS = await encryptBool(directionS);
    const encSizeS = await encryptUint256(sizeS);
    await openPosition({ endex, keeper, user, direction: encDirectionS, size: encSizeS, collateral: collateralS })
  
    // Accrue funding for a bit
    await time.increase(6 * 3600) // 6h
    await endex.updateFunding()
  
    // Pick price that liquidates but leaves positive baseline equity
    // For E=2000, size=30k, coll=6k: P=2390 → equity ≈ 150 (positive), maintenance > 150 → liquidate
    await feed.updateAnswer(price(2390n))
  
    // Liquidation flow -> Awaiting Settlement
    // Step 1: request liquidation checks (starts decrypts)
    await endex.connect(keeper).process([2])
    await coprocessor()
    // Step 2: finalize; should pass liquidatable check and move to Awaiting Settlement
    await endex.connect(keeper).process([2])
    await coprocessor()
  
    // Freeze funding at settlement boundary and compute dF for the short
    await endex.updateFunding()
    const pos = await endex.getPosition(2)
    const entryFunding = await decryptEint256(pos.entryFunding)
    const cumShortNow  = await decryptEint256(await endex.cumFundingShort())
    const dF = cumShortNow - entryFunding
    expect(dF > 0n, 'short dF should be positive under negative rate').to.eq(true)
  
    // Settle; measure only settlement effect on user balance
    const userStart = BigInt(await usdc.balanceOf(user.address))
    await endex.connect(keeper).process([2])
    const userEnd = BigInt(await usdc.balanceOf(user.address))
    const actualPayout = userEnd - userStart
  
    // ---- Expected numbers (mirror contract math):
    // Baseline ignoring funding
    const E = 2000n
    const P = 2390n
    const pnl = (sizeS * (E - P)) / E // negative for short
    let payoutGrossBaseline = collateralS + pnl
    if (payoutGrossBaseline < 0n) payoutGrossBaseline = 0n
    const closeFeeBps = 10n
    const feeBaseline = (payoutGrossBaseline * closeFeeBps) / 10_000n
    const netBaseline = payoutGrossBaseline - feeBaseline
  
    // Funding (short pays under negative rate): size * dF / 1e18
    const fundingUSDC = (sizeS * dF) / ONE_X18
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
  }).timeout(120000);
})
