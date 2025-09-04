// test/funding-transfer.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable } from 'cofhejs/node'
import { expect } from 'chai'

function toUSDC(n: bigint) { return n * 10n ** 6n }    // 6 decimals
function price(n: bigint)  { return n * 10n ** 8n }    // 8 decimals
const ONE_X18 = 10n ** 18n
const CLOSE_FEE_BPS = 10n // 0.1%

// CoFHE decrypts async
function coprocessor(ms = 10_000) {
  return new Promise((r) => setTimeout(r, ms))
}

// Baseline (no price change, no funding) payout net: collateral - close fee
function baselineNetPayout(collateral: bigint): bigint {
  const fee = (collateral * CLOSE_FEE_BPS) / 10_000n
  return collateral - fee
}

describe('Endex — funding transfer', function () {
  async function deployFixture() {
    const [deployer, longUser, shortUser, lp] = await hre.ethers.getSigners()

    // Mock USDC
    const USDC = await hre.ethers.getContractFactory('MintableToken')
    const usdc = await USDC.deploy('USDC', 'USDC', 6)
    const usdcAddr = await usdc.getAddress()

    // Chainlink mock @ $2000 (8d)
    const Feed = await hre.ethers.getContractFactory('MockV3Aggregator')
    const feed = await Feed.deploy(8, price(2000n))
    const feedAddr = await feed.getAddress()

    // Perps (Endex)
    const Perps = await hre.ethers.getContractFactory('Endex')
    const perps = await Perps.deploy(usdcAddr, feedAddr)
    const perpsAddr = await perps.getAddress()

    return { perps, perpsAddr, usdc, feed, deployer, longUser, shortUser, lp }
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    hre.cofhe.mocks.enableLogs()
  })

  it('funding flows from larger long to smaller short (zero price move)', async function () {
    const { perps, perpsAddr, usdc, feed, longUser, shortUser, lp } = await loadFixture(deployFixture)

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
    const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0))
    await perps.requestFundingRateFromSkew()
    const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1))
    await coprocessor()
    await perps.commitFundingRate(epoch)

    // Expect positive funding rate (longs pay, shorts receive)
    const rateX18 = BigInt(await perps.fundingRatePerSecX18())
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
    const longBaselineEnd  = longStartBal  - L_coll + baselineNetPayout(L_coll)
    const shortBaselineEnd = shortStartBal - S_coll + baselineNetPayout(S_coll)

    // Assertions: long paid funding (<= baseline), short received funding (>= baseline)
    expect(longEndBal  <= longBaselineEnd).to.eq(true)
    expect(shortEndBal >= shortBaselineEnd).to.eq(true)

    // show magnitudes for debugging
    console.log('Δlong vs baseline:', (longEndBal - longBaselineEnd).toString())
    console.log('Δshort vs baseline:', (shortEndBal - shortBaselineEnd).toString())
  })
})
