// test/liquidation.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'
import { expect } from 'chai'

function toUSDC(n: bigint) { return n * 10n ** 6n }    // 6 decimals
function price(n: bigint)  { return n * 10n ** 8n }    // 8 decimals
const ONE_X18 = 10n ** 18n

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
    return BigInt(!sign.data ? -1 : 1) * BigInt(v);
}

describe('Endex — Liquidation', function () {
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
    const Perps = await hre.ethers.getContractFactory('EndexHarness')
    const perps = await Perps.deploy(usdcAddr, feedAddr)
    const perpsAddr = await perps.getAddress()

    return { perps, perpsAddr, usdc, feed, deployer, user, lp, keeper, other }
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    //hre.cofhe.mocks.enableLogs()
  })

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

  // --------------------------------------------
  // 2) Liquidations include funding at settlement
  // --------------------------------------------
  it('liquidated LONG under positive rate explicitly pays funding (actual ≈ baseline - size*dF/1e18)', async function () {
    const { perps, perpsAddr, usdc, feed, user, lp } = await loadFixture(deployFixture)
  
    // Pool & user
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))
  
    await usdc.mint(user.address, toUSDC(200_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))
  
    // 1) Ensure POSITIVE rate: open a large LONG to bias skew => longs pay
    {
      const [eL] = await hre.cofhe.expectResultSuccess(
        cofhejs.encrypt([Encryptable.uint256(toUSDC(120_000n))])
      )
      await perps.connect(user).openPosition(true, eL, toUSDC(20_000n), 0, 0)
  
      await coprocessor()
  
      const r = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
      expect(r > 0n, 'expected positive funding rate (longs pay)').to.eq(true)
    }
  
    // 2) Open a 5x LONG we will liquidate with small *positive* equity at liq price
    const collateralL = toUSDC(5_000n)
    const notionalL  = toUSDC(25_000n) // 5x
    const [encSizeL] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalL)])
    )
    await perps.connect(user).openPosition(true, encSizeL, collateralL, 0, 0)
  
    // Accrue funding meaningfully
    await time.increase(3 * 24 * 3600) // 3 days
    await perps.pokeFunding()
  
    // Price low enough to liquidate, but still equity > 0 (baseline)
    // Entry 2000 → at 1619: pnl = 25k * (1619-2000)/2000 = -4,762.5 → equity ~ 237.5 > 0
    await feed.updateAnswer(price(1619n))
  
    // Snapshot funding delta for this position (id = 2)
    const pos2_before = await perps.getPosition(2)
    const cumLong = await cofheUnsealEint256(await perps.cumFundingLongX18())
    const entryFunding2 = await cofheUnsealEint256(pos2_before.entryFundingX18)
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
    const userStart = BigInt(await usdc.balanceOf(user.address))
    await perps.settlePositions([2])
    const userEnd = BigInt(await usdc.balanceOf(user.address))
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
    const { perps, perpsAddr, usdc, feed, user, lp } = await loadFixture(deployFixture)
  
    // Pool & user
    await usdc.mint(lp.address, toUSDC(2_000_000n))
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256)
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n))
  
    await usdc.mint(user.address, toUSDC(200_000n))
    await usdc.connect(user).approve(perpsAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))
  
    // Ensure NEGATIVE rate: open a large SHORT only to bias skew (shorts pay)
    {
      const [eS] = await hre.cofhe.expectResultSuccess(
        cofhejs.encrypt([Encryptable.uint256(toUSDC(150_000n))])
      )
      await perps.connect(user).openPosition(false, eS, toUSDC(30_000n), 0, 0)
      await coprocessor()
      const rate = await cofheUnsealEint256(await perps.fundingRatePerSecX18())
      expect(rate < 0n, 'expected negative funding rate (shorts pay)').to.eq(true)
    }
  
    // Open the HIGH-LEV SHORT we will liquidate
    const collateralS = toUSDC(6_000n)
    const notionalS  = toUSDC(30_000n) // 5x
    const [encSizeS] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint256(notionalS)])
    )
    await perps.connect(user).openPosition(false, encSizeS, collateralS, 0, 0)
  
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
    const entryFunding = await cofheUnsealEint256(pos.entryFundingX18)
    const cumShortNow  = await cofheUnsealEint256(await perps.cumFundingShortX18())
    const dF = cumShortNow - entryFunding
    expect(dF > 0n, 'short dF should be positive under negative rate').to.eq(true)
  
    // Settle; measure only settlement effect on user balance
    await coprocessor() // size decrypt
    const userStart = BigInt(await usdc.balanceOf(user.address))
    await perps.settlePositions([2])
    const userEnd = BigInt(await usdc.balanceOf(user.address))
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
})
