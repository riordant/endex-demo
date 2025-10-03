import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { expect } from 'chai'

import {
  _deployFixture,
  toUnderlying,
  coprocessor,
  encryptBool,
  encryptUint256,
  encInvalidRange,
  encValidRange,
  entryPrice,
  requestPosition,
  parseStatus,
  openPosition,
} from './utils'

describe('Endex — Request-time validations (size, range, OI caps)', function () {
  async function deployFixture() {
    return (await _deployFixture());
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
  })

  it('fails when size < MIN_SIZE (sizeGTE == false)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    // Seed TVL (to avoid unintended zero-cap edge cases)
    await usdc.mint(lp.address, toUnderlying(200_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(200_000n))

    await usdc.mint(user.address, toUnderlying(800_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const direction = await encryptBool(true) // long/short doesn’t matter here
    const sizeTooSmall = await encryptUint256(toUnderlying(5n)) // 5 USDC < MIN_SIZE = 10 USDC
    const range = await encValidRange(entryPrice)

    const collateral = toUnderlying(1_000n)

    const { p } = await requestPosition({ endex, keeper, user, direction, size: sizeTooSmall, collateral, range })

    // Expect refund and not moved to Pending/Open
    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart) // full refund
  })

  it('fails when size > collateral * 5 (sizeLTE == false; leverage > 5x)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUnderlying(300_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(300_000n))

    await usdc.mint(user.address, toUnderlying(50_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const direction = await encryptBool(true)
    const collateral = toUnderlying(10_000n)
    const sizeTooBig = await encryptUint256(toUnderlying(60_000n)) // 6x > 5x
    const range = await encValidRange(entryPrice)

    const { p } = await requestPosition({ endex, keeper, user, direction, size: sizeTooBig, collateral, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when entry range invalid (low + BUFFER >= high)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUnderlying(200_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(200_000n))

    await usdc.mint(user.address, toUnderlying(20_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const direction = await encryptBool(false)
    const sizeOk    = await encryptUint256(toUnderlying(20_000n))
    // BUFFER = 1e8 (per your contract)
    const bufferE8 = 1_00_000_000n
    const rangeBad = await encInvalidRange(bufferE8)

    const collateral = toUnderlying(10_000n)

    const { p } = await requestPosition({ endex, keeper, user, direction, size: sizeOk, collateral, range: rangeBad })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when LONG side cap would be exceeded (isLong==true && longOk==false)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    // TVL = 100k → capLong = 50k, capTotal = 70k
    await usdc.mint(lp.address, toUnderlying(100_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(100_000n))

    await usdc.mint(user.address, toUnderlying(50_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const dirLong  = await encryptBool(true)
    const size60k  = await encryptUint256(toUnderlying(60_000n)) // > capLong (50k)
    const range    = await encValidRange(entryPrice)
    const collateral = toUnderlying(15_000n) // 60k / 15k = 4x (within leverage)

    const { p } = await requestPosition({ endex, keeper, user, direction: dirLong, size: size60k, collateral, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when SHORT side cap would be exceeded (isLong==false && shortOk==false)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    // TVL = 100k → capShort = 50k
    await usdc.mint(lp.address, toUnderlying(100_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(100_000n))

    await usdc.mint(user.address, toUnderlying(50_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const dirShort = await encryptBool(false)
    const size60k  = await encryptUint256(toUnderlying(60_000n)) // > capShort (50k)
    const range    = await encValidRange(entryPrice)
    const collateral = toUnderlying(15_000n)

    const { p } = await requestPosition({ endex, keeper, user, direction: dirShort, size: size60k, collateral, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })

  it('fails when TOTAL OI cap would be exceeded (totalOk==false)', async function () {
    const { endex, endexAddr, usdc, userA, userB, lp, keeper } = await loadFixture(deployFixture)

    // TVL = 100k → capTotal = 70k, capSide = 50k
    await usdc.mint(lp.address, toUnderlying(100_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(100_000n))

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUnderlying(100_000n))
      await usdc.connect(u).approve(endexAddr, hre.ethers.MaxUint256)
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u))
    }

    // First OPEN a valid long of 40k (within caps)
    {
      const direction = await encryptBool(true)
      const size  = await encryptUint256(toUnderlying(40_000n)) // < 50k side cap
      const collateral = toUnderlying(10_000n) // 4x
      // Request
      await openPosition( { endex, keeper, user: userA, direction, size, collateral } )
    }

    // Now try to OPEN another 40k on the other side → total would be 80k > 70k (total cap),
    // while each side individually remains <= 50k, so the block is **due to total cap**.
    const userBStart = BigInt(await usdc.balanceOf(userB.address))

    const dirShort = await encryptBool(false)
    const size40k  = await encryptUint256(toUnderlying(40_000n))
    const range    = await encValidRange(entryPrice)
    const coll     = toUnderlying(10_000n)

    const { p } = await requestPosition({ endex, keeper, user: userB, direction: dirShort, size: size40k, collateral: coll, range })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userBEnd = BigInt(await usdc.balanceOf(userB.address))
    expect(userBEnd).to.eq(userBStart)
  })

  // (Optional) Duplicate of first bullet in your list:
  it('fails again for size < MIN_NOTIONAL_USDC (duplicate check for completeness)', async function () {
    const { endex, endexAddr, usdc, userA: user, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUnderlying(150_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(150_000n))

    await usdc.mint(user.address, toUnderlying(10_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    const userStart = BigInt(await usdc.balanceOf(user.address))

    const dir = await encryptBool(true)
    const tooSmall = await encryptUint256(toUnderlying(9n)) // 9 < 10
    const range = await encValidRange(entryPrice)

    const { p } = await requestPosition({
      endex, keeper, user, direction: dir, size: tooSmall, collateral: toUnderlying(1_000n), range
    })

    expect(parseStatus(p.status)).to.eq('Requested')
    expect(p.validity.removed).to.eq(true)

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    expect(userEnd).to.eq(userStart)
  })
})
