// test/SimpleEncryptedPerpsNew.async-funding-and-liquidation.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'
import { expect } from 'chai'

function toUSDC(n: bigint) { return n * 10n ** 6n }    // 6 decimals
function price(n: bigint)  { return n * 10n ** 8n }    // 8 decimals
const ONE_X18 = 10n ** 18n

// CoFHE decrypts async
function coprocessor(ms = 10_000) {
  console.log("awaiting coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}

describe('SimpleEncryptedPerpsNew — async funding + encrypted liquidation', function () {
  async function deployFixture() {
    const [deployer, user, lp, keeper] = await hre.ethers.getSigners()

    // Mock USDC
    const USDC = await hre.ethers.getContractFactory('MintableToken')
    const usdc = await USDC.deploy('USDC', 'USDC', 6)
    const usdcAddr = await usdc.getAddress()

    // Chainlink mock @ $2000 (8d)
    const Feed = await hre.ethers.getContractFactory('MockV3Aggregator')
    const feed = await Feed.deploy(8, price(2000n))
    const feedAddr = await feed.getAddress()

    // Perps
    const Perps = await hre.ethers.getContractFactory('SimpleEncryptedPerpsNew')
    const perps = await Perps.deploy(usdcAddr, feedAddr)
    const perpsAddr = await perps.getAddress()

    return { perps, perpsAddr, usdc, feed, deployer, user, lp, keeper }
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    hre.cofhe.mocks.enableLogs()
  })

  it.only('accrues funding via async request/commit and charges it only at settlement', async function () {
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
      true, encSize, collateral, 0, 0, 0
    )

    let pos = await perps.getPosition(1)
    expect(pos.status).to.equal(0) // Open
    expect(pos.entryPrice).to.equal(price(2000n))

    // === Async funding rate: request (snapshots skew, starts decrypts) ===
    const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0)) // supports both old/new compilers
    await perps.requestFundingRateFromSkew()
    const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
    expect(await perps.fundingPending()).to.equal(true)

    // Wait for decrypts of numerator+flag
    await coprocessor()

    // === Commit with epoch ===
    await perps.commitFundingRate(epoch)
    expect(await perps.fundingPending()).to.equal(false)

    // Optional: read rate (may be small/zero depending on params)
    const rateX18 = BigInt(await perps.fundingRatePerSecX18())
    // console.log('rateX18/sec =', rateX18.toString())

    // Advance time and accrue with current rate
    const dt = 24 * 3600 // 1 day
    await time.increase(dt)
    await perps.pokeFunding()

    // Check cumulative vs entry snapshot (for later expected settlement math)
    const cumLong = BigInt(await perps.cumFundingLongX18())
    const entryFunding = BigInt((await perps.getPosition(1)).entryFundingX18)
    const fundingDeltaX18 = cumLong - entryFunding

    // Ensure no interim cashflows to user
    const userBalPreClose = BigInt(await usdc.balanceOf(user.address))
    expect(userBalPreClose).to.equal(userBalStart - collateral)

    // Move price up +5% to generate PnL; funding should reduce payout
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

    // Verify settlement-only effect on user balance
    const userBalEnd = BigInt(await usdc.balanceOf(user.address))

    // Compute expected payout (approx) using same formula as contract:
    // PnL = size * (P-E)/E
    const E = 2000n; const P = 2100n
    const pnl = (notional * (P - E)) / E
    // Funding = size * fundingDeltaX18 / 1e18 (may be +/-)
    const fundingUSDC = (notional * fundingDeltaX18) / ONE_X18
    let payoutGross = collateral + pnl - fundingUSDC
    if (payoutGross < 0n) payoutGross = 0n
    const fee = (payoutGross * 10n) / 10_000n // 10 bps
    const payoutNet = payoutGross - fee

    const expectedEnd = userBalStart - collateral + payoutNet
    const diff = userBalEnd - expectedEnd
    // Allow tiny rounding slack
    expect(diff >= -5n && diff <= 5n).to.eq(true)
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

    await perps.connect(user).openPosition(true, encSize, collateral, 0, 0, 0)

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
})
