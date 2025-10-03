// test/price-impact.test.ts
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { expect } from 'chai'

import {
    _deployFixture, 
    baselineNetPayout, 
    closeFeeOn, 
    coprocessor, 
    encryptBool, 
    encryptUint256, 
    EPS, 
    openPosition,
    PX0, 
    toUnderlying, 
    decryptEint256,
} from './utils'

describe("Endex — Price Impact (entry + exit)", function () {
  async function deployFixture() {
    return (await _deployFixture());
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    //hre.cofhe.mocks.enableLogs() // enable for CoFHE operation logs
  })

  it("Round-trip neutrality (same K): open and immediately close at same price", async function () {
    const { endex, endexAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture);

    // Seed pool big → keep L (and thus K) nearly constant
    await usdc.mint(lp.address, toUnderlying(2_000_000n));
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256);
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n));

    // User setup
    await usdc.mint(user.address, toUnderlying(200_000n));
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256);
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user));

    // Create a little skew (so impact math isn’t degenerate), but keep it stable
    {
      const direction = await encryptBool(true);
      const size = await encryptUint256(toUnderlying(120_000n));
      await openPosition({ endex, keeper, user, direction, size, collateral: toUnderlying(24_000n)});

      // Close the “skew maker” so we don’t retain extra state; neutrality only needs stable K.
      await endex.connect(user).closePosition(1);
      await coprocessor();
      await endex.connect(keeper).process([1]);
    }

    // Now do the round-trip we actually measure
    const collateral = toUnderlying(10_000n);
    const notional = toUnderlying(40_000n);
    const direction = await encryptBool(true);
    const size = await encryptUint256(notional);

    // Open → immediate close at same price
    const start = BigInt(await usdc.balanceOf(user.address));
    await openPosition({ endex, keeper, user, direction, size, collateral });

    await endex.connect(user).closePosition(2);
    await coprocessor();
    await endex.connect(keeper).process([2]);

    const end = BigInt(await usdc.balanceOf(user.address));

    // Baseline ignoring impact (no price move, funding≈0): payoutGross=collateral; fee on payout
    const baseGross = collateral;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;

    // Actual net INCLUDING entry+exit impact which should cancel if K same
    const actualNet = end - (start - collateral);

    // Allow tiny EPS for fee rounding / minuscule TVL drift
    const diff = actualNet > baseNet ? actualNet - baseNet : baseNet - actualNet;
    expect(diff <= EPS, `round-trip diff too large: |${actualNet} - ${baseNet}| = ${diff}`).to.eq(true);
  }).timeout(120000);

  it("Skew-improving exit (same K): entry ≈ exit, net ≈ baseline", async function () {
    const { endex, endexAddr, usdc, feed, userA, userB, lp, keeper } = await loadFixture(deployFixture);

    // Large pool → stable K
    await usdc.mint(lp.address, toUnderlying(2_000_000n));
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256);
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n));

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUnderlying(300_000n));
      await usdc.connect(u).approve(endexAddr, hre.ethers.MaxUint256);
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u));
    }

    // Create positive skew (long>short)
    {
      const direction = await encryptBool(true);
      const size = await encryptUint256(toUnderlying(150_000n));
      await openPosition({ endex, keeper, user: userB, direction, size, collateral: toUnderlying(30_000n)});
    }

    // Open a small SHORT (x < s) → entry impact is a gain;
    // Later close while skew still >0 → exit (long trade) is a cost; with same K they should cancel.
    const collateral = toUnderlying(8_000n);
    const notional = toUnderlying(24_000n);
    const size = await encryptUint256(notional);
    const direction = await encryptBool(false);

    const start = BigInt(await usdc.balanceOf(userA.address));
    await openPosition({ endex, keeper, user: userA, direction, size, collateral });

    // keep price/funding stable; tiny time passes to show it doesn’t matter
    await time.increase(60);
    await endex.updateFunding();

    await endex.connect(userA).closePosition(2);
    await coprocessor();
    await endex.connect(keeper).process([2]);

    const end = BigInt(await usdc.balanceOf(userA.address));

    const baseGross = collateral;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;
    const actualNet = end - (start - collateral);

    const diff = actualNet > baseNet ? actualNet - baseNet : baseNet - actualNet;
    expect(diff <= EPS, `skew-improving exit should net ≈ baseline; diff=${diff}`).to.eq(true);
  }).timeout(120000);

  it("Crossover exit (same K): exit delta is a rebate; net ≈ baseline when K equal", async function () {
    const { endex, endexAddr, usdc, feed, userA, userB, lp, keeper } = await loadFixture(deployFixture);

    // Big pool
    await usdc.mint(lp.address, toUnderlying(2_000_000n));
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256);
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n));

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUnderlying(400_000n));
      await usdc.connect(u).approve(endexAddr, hre.ethers.MaxUint256);
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u));
    }

    // Start with s>0 by opening a big long on userB
    let direction = await encryptBool(true);
    const size = await encryptUint256(toUnderlying(100_000n));
    await openPosition({ endex, keeper, user: userB, direction, size, collateral: toUnderlying(20_000n)});

    // UserA opens a big LONG x → s_exit for the future close is s+x. On exit (short trade),
    // Δ_exit = (s_exit - x)^2 - s_exit^2 = x^2 - 2 s_exit x < 0 → rebate.
    // With same K, entry cost magnitude == exit rebate magnitude → net ≈ baseline.
    const collateral = toUnderlying(12_000n);
    const notional = toUnderlying(48_000n);

    const encSize = await encryptUint256(notional);

    const start = BigInt(await usdc.balanceOf(userA.address));
    await openPosition({ endex, keeper, user: userA, direction, size: encSize, collateral });

    await time.increase(60);
    await endex.updateFunding();

    await endex.connect(userA).closePosition(2);
    await coprocessor();
    await endex.connect(keeper).process([2]);

    const end = BigInt(await usdc.balanceOf(userA.address));

    const baseGross = collateral;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;
    const actualNet = end - (start - collateral);

    // Because exit is a rebate, actualNet should not be below baseline; with equal K it ≈ baseline.
    expect(actualNet >= baseNet - EPS, "exit rebate should not make net < baseline").to.eq(true);

    const diff = actualNet > baseNet ? actualNet - baseNet : baseNet - actualNet;
    console.log("diff: ", diff);
    expect(diff <= EPS, `crossover round-trip should net ≈ baseline when K equal; diff=${diff}`).to.eq(true);
  }).timeout(120000);

  it("Utilization drift: higher |funding| at exit → larger |K| → non-cancelling round-trip", async function () {
    const { endex, endexAddr, usdc, feed, userA, userB, lp, keeper } = await loadFixture(deployFixture);

    // Big pool to reduce noise, but we will explicitly raise |funding| between entry and exit
    await usdc.mint(lp.address, toUnderlying(3_000_000n));
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256);
    await endex.connect(lp).lpDeposit(toUnderlying(3_000_000n));

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUnderlying(500_000n));
      await usdc.connect(u).approve(endexAddr, hre.ethers.MaxUint256);
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u));
    }

    // Keep funding ~0 for ENTRY
    // Create initial slight skew so impact is active
    const direction = await encryptBool(true);
    const encBias = await encryptUint256(toUnderlying(80_000n));
    await openPosition({ endex, keeper, user: userB, direction, size: encBias, collateral: toUnderlying(16_000n)});

    // UserA opens LONG (entry cost at low K)
    const collateral = toUnderlying(10_000n);
    const notional = toUnderlying(40_000n);
    const encSize = await encryptUint256(notional);

    const start = BigInt(await usdc.balanceOf(userA.address));
    await openPosition({ endex, keeper, user: userA, direction, size: encSize, collateral });

    // Now RAISE |funding| to shrink L and increase K for EXIT
    // We can bias skew further and commit a funding rate to raise |rate|
    {
      const encMore = await encryptUint256(toUnderlying(150_000n));
      await openPosition({ endex, keeper, user: userB, direction, size: encMore, collateral: toUnderlying(30_000n) });

      const rate = await decryptEint256(await endex.fundingRatePerSecond());
      expect(rate > 0).to.be.true;
    }

    // Exit: close the long (short trade) under higher K ⇒ exit rebate magnitude > entry cost
    await endex.connect(userA).closePosition(2);
    await coprocessor();
    await endex.connect(keeper).process([2]);

    const end = BigInt(await usdc.balanceOf(userA.address));

    const baseGross = collateral;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;
    const actualNet = end - (start - collateral);

    // Because exit rebate is scaled by a larger K than entry cost, net > baseline.
    console.log("actualNet: ", actualNet);
    console.log("baseNet: ", baseNet);
    expect(actualNet > baseNet, `expected positive drift: actual ${actualNet} > baseline ${baseNet}`).to.eq(true);
  }).timeout(120000);

  it('long @ zero price change ends <= baseline (entry impact loss for long on non-negative skew)', async function () {
    const { endex, endexAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture)

    // LP and user
    await usdc.mint(lp.address, toUnderlying(2_000_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n))

    await usdc.mint(user.address, toUnderlying(200_000n))
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

    // First trade is LONG => skew >= 0 at entry.
    const collateral = toUnderlying(20_000n)
    const notional  = toUnderlying(80_000n) // 4x
    const direction = await encryptBool(true);
    const size = await encryptUint256(notional);

    const userStart = BigInt(await usdc.balanceOf(user.address))

    await openPosition({ endex, keeper, user, direction, size, collateral })

    // Close → AwaitingSettlement
    await endex.connect(user).closePosition(1)
    await coprocessor()
    await endex.connect(keeper).process([1])

    const userEnd = BigInt(await usdc.balanceOf(user.address))
    const baseNoImpact = baselineNetPayout(collateral, notional, PX0, PX0, 10n)
    const expectedMax = userStart - collateral + baseNoImpact

    console.log("userStart: ", userStart);
    console.log("userEnd: ", userEnd);
    console.log("collateral: ", collateral);
    console.log("baseNoImpact: ", baseNoImpact);
    console.log("expectedMax: ", expectedMax);

    // With entry impact, payout should be <= baseline
    const EPS = 50_000n // small slack for rounding (0.05 USDC)
    expect((userEnd - EPS) <= expectedMax).to.eq(true)
  })

  it('short on positive skew @ zero price change ends >= baseline (entry impact gain for short)', async function () {
    const { endex, endexAddr, usdc, feed, userA, userB, lp, keeper } = await loadFixture(deployFixture)
  
    // Fund LP
    await usdc.mint(lp.address, toUnderlying(2_000_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n))
  
    // Fund users
    await usdc.mint(userA.address, toUnderlying(200_000n))
    await usdc.mint(userB.address, toUnderlying(200_000n))
    await usdc.connect(userA).approve(endexAddr, hre.ethers.MaxUint256)
    await usdc.connect(userB).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userA))
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userB))
  
    // 1) Create **positive skew**: OTHER opens a large LONG first.
    {
      const collateral = toUnderlying(40_000n)
      const notional   = toUnderlying(160_000n) // 4x
      const direction  = await encryptBool(true)
      const size  = await encryptUint256(notional);
      await openPosition({ endex, keeper, user: userB, direction, size, collateral })
    }
  
    // 2) USER opens a SHORT on positive skew ⇒ short should receive positive entry impact.
    const collateral = toUnderlying(20_000n)
    const notional  = toUnderlying(80_000n)
    const direction = await encryptBool(false)
    const size  = await encryptUint256(notional);
  
    const userAStart = BigInt(await usdc.balanceOf(userA.address))
    await openPosition({ endex, keeper, user: userA, direction, size, collateral })
  
    // Close & settle
    await endex.connect(userA).closePosition(2) // userA's position is id=2
    await coprocessor()
    await endex.connect(keeper).process([2])
  
    const userAEnd = BigInt(await usdc.balanceOf(userA.address))
    const baseNoImpact = ((): bigint => {
      const pnl = (notional * (PX0 - PX0)) / PX0 // zero
      let gross = collateral + pnl
      if (gross < 0n) gross = 0n
      const fee = (gross * 10n) / 10_000n // 10 bps close fee
      return gross - fee
    })()
    const expectedMin = userAStart - collateral + baseNoImpact
  
    // With positive skew at entry, a SHORT receives positive entry impact ⇒ >= baseline
    expect(userAEnd >= expectedMin).to.eq(true)
  })

  it('long opened after large short (negative skew) ends >= baseline at zero price change', async function () {
    const { endex, endexAddr, usdc, feed, userA, userB, lp, keeper } = await loadFixture(deployFixture)

    await usdc.mint(lp.address, toUnderlying(3_000_000n))
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256)
    await endex.connect(lp).lpDeposit(toUnderlying(3_000_000n))

    // Two users so we can create skew with one and trade with the other
    await usdc.mint(userA.address, toUnderlying(200_000n))
    await usdc.mint(userB.address, toUnderlying(200_000n))
    await usdc.connect(userA).approve(endexAddr, hre.ethers.MaxUint256)
    await usdc.connect(userB).approve(endexAddr, hre.ethers.MaxUint256)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userA))
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userB))

    // 1) OTHER opens a big SHORT to push skew negative
    {
      const collateral = toUnderlying(40_000n)
      const notional  = toUnderlying(200_000n) // 5x
      const direction = await encryptBool(false);
      const size = await encryptUint256(notional);
      await openPosition({ endex, keeper, user: userB, direction, size, collateral })
    }

    // 2) USER opens LONG after skew is negative => long should receive positive entry impact
    const collateral = toUnderlying(20_000n)
    const notional  = toUnderlying(80_000n)
    const direction = await encryptBool(true);
    const size = await encryptUint256(notional);

    const userAStart = BigInt(await usdc.balanceOf(userA.address))

    await openPosition({ endex, keeper, user: userA, direction, size, collateral })

    // Close & settle
    await endex.connect(userA).closePosition(2) // userA's position is id=2
    await coprocessor()
    await endex.connect(keeper).process([2])

    const userAEnd = BigInt(await usdc.balanceOf(userA.address))
    const baseNoImpact = baselineNetPayout(collateral, notional, PX0, PX0, 10n)
    const expectedMin = userAStart - collateral + baseNoImpact

    // With negative skew at entry, long receives positive entry impact => >= baseline
    expect(userAEnd >= expectedMin).to.eq(true)
  })

  it("round trip at same price: entry + exit impact approximately cancels (immediate close)", async function () {
    const { endex, endexAddr, usdc, feed, userA: user, lp, keeper } = await loadFixture(deployFixture);

    // Seed pool + user
    await usdc.mint(lp.address, toUnderlying(2_000_000n));
    await usdc.connect(lp).approve(endexAddr, hre.ethers.MaxUint256);
    await endex.connect(lp).lpDeposit(toUnderlying(2_000_000n));

    await usdc.mint(user.address, toUnderlying(200_000n));
    await usdc.connect(user).approve(endexAddr, hre.ethers.MaxUint256);
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user));

    // Open a small long then close immediately
    const collateral = toUnderlying(10_000n);
    const direction = await encryptBool(true);
    const size = await encryptUint256(toUnderlying(30_000n));

    const start = BigInt(await usdc.balanceOf(user.address));
    await openPosition({ endex, keeper, user, direction, size, collateral });

    // No time passage, no price change — K ~ unchanged between entry/exit
    await endex.connect(user).closePosition(1);
    await coprocessor();
    await endex.connect(keeper).process([1]);
    const end = BigInt(await usdc.balanceOf(user.address));

    const net = end - (start - collateral);

    // Baseline: zero price move, only close fee applied on payout (which is ~collateral)
    const gross = collateral;
    const fee   = (gross * 10n) / 10_000n; // 0.1%
    const base  = gross - fee;

    // Entry + exit impact should cancel; allow tiny rounding slack
    const diff = net > base ? net - base : base - net;

    // 2e3 wei USDC ≈ 0.003 USDC slack to tolerate rounding under FHE math
    const EPS = 3_000n;
    expect(diff <= EPS, `round-trip drift too large: |${diff}| > ${EPS}`).to.eq(true);
  });
});
