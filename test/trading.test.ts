import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { expect } from 'chai'

import {
  _deployFixture,
  toUSDC,
  price,
  PX0,
  coprocessor,
  encryptBool,
  encryptUint256,
  parseStatus,
} from './utils'

/** Encrypt a valid ±$1 price band around $2000 (8d), wide enough to satisfy BUFFER */
async function encValidRange() {
  // low = 1999, high = 2001
  const low  = await encryptUint256(price(1999n))
  const high = await encryptUint256(price(2001n))
  return [low, high] as const
}

/** Encrypt an *invalid* range such that (low + BUFFER) >= high so _validateRange() fails */
async function encInvalidRange(bufferE8: bigint) {
  // Pick low = 2000e8; high = low + buffer - 1 ⇒ invalid
  const lowPlain  = PX0
  const highPlain = PX0 + bufferE8 - 1n
  const low  = await encryptUint256(lowPlain)
  const high = await encryptUint256(highPlain)
  return [low, high] as const
}

/** Request an open, then run one keeper process pass (Requested → refund or Pending). */
async function requestAndProcess({
  endex, keeper, user, direction, size, collateral, range
}: any) {
  const [low, high] = range
  await endex.connect(user).openPositionRequest(direction, size, [low, high], collateral)
  await coprocessor()                                 // allow decrypt of requestValid
  const id = Number(await endex.nextPositionId()) - 1 // last requested id
  await endex.connect(keeper).process([id])           // processes Requested state
  await coprocessor()
  const p = await endex.getPosition(id)
  return { id, p }
}

describe.only('Endex — Request-time validations (size, range, OI caps)', function () {
  async function deployFixture() {
    return (await _deployFixture());
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
  })

  it('fails when size < MIN_SIZE (sizeGTE == false)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    // Seed TVL (to avoid unintended zero-cap edge cases)
    await usdc.mint(lp.address, toUSDC(200_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUSDC(200_000n))

    await usdc.mint(user.address, toUSDC(800_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const direction = await encryptBool(true) // long/short doesn’t matter here
    const sizeTooSmall = await encryptUint256(toUSDC(5n)) // 5 USDC < MIN_SIZE = 10 USDC
    const range = await encValidRange()

    const collateral = toUSDC(1_000n)

    const { p } = await requestAndProcess({ endex, keeper, user, direction, size: sizeTooSmall, collateral, range })

    // Expect refund and not moved to Pending/Open
    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart) // full refund
  })

  it('fails when size > collateral * 5 (sizeLTE == false; leverage > 5x)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(300_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUSDC(300_000n))

    await usdc.mint(user.address, toUSDC(50_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const direction = await encryptBool(true)
    const collateral = toUSDC(10_000n)
    const sizeTooBig = await encryptUint256(toUSDC(60_000n)) // 6x > 5x
    const range = await encValidRange()

    const { p } = await requestAndProcess({ endex, keeper, user, direction, size: sizeTooBig, collateral, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when entry range invalid (low + BUFFER >= high)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(200_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUSDC(200_000n))

    await usdc.mint(user.address, toUSDC(20_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const direction = await encryptBool(false)
    const sizeOk    = await encryptUint256(toUSDC(20_000n))
    // BUFFER = 1e8 (per your contract)
    const bufferE8 = 1_00_000_000n
    const rangeBad = await encInvalidRange(bufferE8)

    const collateral = toUSDC(10_000n)

    const { p } = await requestAndProcess({ endex, keeper, user, direction, size: sizeOk, collateral, range: rangeBad })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when LONG side cap would be exceeded (isLong==true && longOk==false)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    // TVL = 100k → capLong = 50k, capTotal = 70k
    await usdc.mint(lp.address, toUSDC(100_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUSDC(100_000n))

    await usdc.mint(user.address, toUSDC(50_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const dirLong  = await encryptBool(true)
    const size60k  = await encryptUint256(toUSDC(60_000n)) // > capLong (50k)
    const range    = await encValidRange()
    const collateral = toUSDC(15_000n) // 60k / 15k = 4x (within leverage)

    const { p } = await requestAndProcess({ endex, keeper, user, direction: dirLong, size: size60k, collateral, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when SHORT side cap would be exceeded (isLong==false && shortOk==false)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    // TVL = 100k → capShort = 50k
    await usdc.mint(lp.address, toUSDC(100_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUSDC(100_000n))

    await usdc.mint(user.address, toUSDC(50_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const dirShort = await encryptBool(false)
    const size60k  = await encryptUint256(toUSDC(60_000n)) // > capShort (50k)
    const range    = await encValidRange()
    const collateral = toUSDC(15_000n)

    const { p } = await requestAndProcess({ endex, keeper, user, direction: dirShort, size: size60k, collateral, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when TOTAL OI cap would be exceeded (totalOk==false)', async function () {
    const { endex, endexAddr, usdc, userA, userB, lp, keeper } = await loadFixture(deployFixture)

    // TVL = 100k → capTotal = 70k, capSide = 50k
    await usdc.mint(lp.address, toUSDC(100_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUSDC(100_000n))

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(100_000n))
      await usdc.connect(u).approve(endexAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u))
    }

    // First OPEN a valid long of 40k (within caps)
    {
      const dir = await encryptBool(true)
      const sz  = await encryptUint256(toUSDC(40_000n)) // < 50k side cap
      const rg  = await encValidRange()
      const coll= toUSDC(10_000n) // 4x
      // Request
      await endex.connect(userA).openPositionRequest(dir, sz, rg, coll)
      await coprocessor()
      // Requested -> Pending
      let id = Number(await endex.nextPositionId()) - 1
      await endex.connect(keeper).process([id])
      await coprocessor()
      // Pending -> Open
      await endex.connect(keeper).process([id])
      await coprocessor()
      const p = await endex.getPosition(id)
      expect(parseStatus(p.status)).to.eq('Open')
    }

    // Now try to OPEN another 40k on the other side → total would be 80k > 70k (total cap),
    // while each side individually remains <= 50k, so the block is **due to total cap**.
    const userBStart = BigInt(await usdc.balanceOf(userB.address))

    const dirShort = await encryptBool(false)
    const size40k  = await encryptUint256(toUSDC(40_000n))
    const range    = await encValidRange()
    const coll     = toUSDC(10_000n)

    const { p } = await requestAndProcess({ endex, keeper, user: userB, direction: dirShort, size: size40k, collateral: coll, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userBEnd = BigInt(await usdc.balanceOf(userB.address))
    expect(userBEnd).to.eq(userBStart)
  })

  // (Optional) Duplicate of first bullet in your list:
  it('fails again for size < MIN_NOTIONAL_USDC (duplicate check for completeness)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUSDC(150_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUSDC(150_000n))

    await usdc.mint(user.address, toUSDC(10_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const dir = await encryptBool(true)
    const tooSmall = await encryptUint256(toUSDC(9n)) // 9 < 10
    const range = await encValidRange()

    const { p } = await requestAndProcess({
      endex, keeper, user, direction: dir, size: tooSmall, collateral: toUSDC(1_000n), range
    })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })
})
