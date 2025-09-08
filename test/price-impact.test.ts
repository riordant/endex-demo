import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable } from 'cofhejs/node'
import { expect } from 'chai'

// ---------- Local tiny helpers ----------
const toUSDC = (x: bigint) => x * 10n ** 6n; // 6d
const price  = (p8: bigint) => p8 * 10n ** 8n; // 8d (Chainlink)
const EPS    = 50n; // a few ~cents on typical sizes; tune if needed
// Keep oracle price constant across most tests
const PX0 = price(2000n);

// CoFHE decrypts async
function coprocessor(ms = 10_000) {
  console.log("waiting for coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}

// ---------- Small utilities specific to these tests ----------
async function encryptUSDC(usdcVal: bigint) {
  const [enc] = await hre.cofhe.expectResultSuccess(
    cofhejs.encrypt([Encryptable.uint256(usdcVal)])
  );
  return enc;
}

async function ensurePositiveFunding(perps: any) {
  const epochBefore = Number(await perps.fundingEpoch?.().catch(() => 0));
  await perps.requestFundingRateFromSkew();
  const epoch = Number(await perps.fundingEpoch?.().catch(() => epochBefore + 1));
  await coprocessor();
  await perps.commitFundingRate(epoch);
  const rate = BigInt(await perps.fundingRatePerSecX18());
  // We just need |rate| > 0; sign doesn’t matter for K—only |rate| feeds utilization proxy.
  return rate;
}

function closeFeeOn(gross: bigint) {
  // Your CLOSE_FEE_BPS is 10; divisor 10_000
  return (gross * 10n) / 10_000n;
}

// ======================================================================
// Price Impact — Exit Impact test suite
// ======================================================================
describe.only("Endex — price impact (entry + exit)", function () {

  async function deployFixture() {
    const [deployer, userA, userB, lp] = await hre.ethers.getSigners()

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

    return { perps, perpsAddr, usdc, feed, deployer, userA, userB, lp }
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
    //hre.cofhe.mocks.enableLogs()
  })

  it.only("Round-trip neutrality (same K): open and immediately close at same price", async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp } = await loadFixture(deployFixture);

    // Seed pool big → keep L (and thus K) nearly constant
    await usdc.mint(lp.address, toUSDC(2_000_000n));
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256);
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n));

    // User setup
    await usdc.mint(userA.address, toUSDC(200_000n));
    await usdc.connect(userA).approve(perpsAddr, hre.ethers.MaxUint256);
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(userA));

    // Fix price; keep funding as deployed (≈0)
    await feed.updateAnswer(PX0);

    // Create a little skew (so impact math isn’t degenerate), but keep it stable
    {
      const encBig = await encryptUSDC(toUSDC(120_000n));
      await perps.connect(userA).openPosition(true, encBig, toUSDC(20_000n), 0, 0);
      await coprocessor();
      // Close the “skew maker” so we don’t retain extra state; neutrality only needs stable K.
      await perps.connect(userA).closePosition(1);
      await coprocessor();
      await perps.settlePositions([1]);
    }

    // Now do the round-trip we actually measure
    const coll = toUSDC(10_000n);
    const notional = toUSDC(40_000n);
    const enc = await encryptUSDC(notional);

    // Open → immediate close at same price
    await feed.updateAnswer(PX0);
    const start = BigInt(await usdc.balanceOf(userA.address));
    await perps.connect(userA).openPosition(true, enc, coll, 0, 0);
    await coprocessor();

    await perps.connect(userA).closePosition(2);
    await coprocessor();
    await perps.settlePositions([2]);

    const end = BigInt(await usdc.balanceOf(userA.address));

    // Baseline ignoring impact (no price move, funding≈0): payoutGross=coll; fee on payout
    const baseGross = coll;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;

    // Actual net INCLUDING entry+exit impact which should cancel if K same
    const actualNet = end - (start - coll);

    // Allow tiny EPS for fee rounding / minuscule TVL drift
    const diff = actualNet > baseNet ? actualNet - baseNet : baseNet - actualNet;
    expect(diff <= EPS, `round-trip diff too large: |${actualNet} - ${baseNet}| = ${diff}`).to.eq(true);
  }).timeout(120000);

  it("Skew-improving exit (same K): entry ≈ exit, net ≈ baseline", async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp } = await loadFixture(deployFixture);

    // Large pool → stable K
    await usdc.mint(lp.address, toUSDC(2_000_000n));
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256);
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n));

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(300_000n));
      await usdc.connect(u).approve(perpsAddr, hre.ethers.MaxUint256);
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u));
    }

    await feed.updateAnswer(PX0);

    // Create positive skew (long>short)
    {
      const encLong = await encryptUSDC(toUSDC(150_000n));
      await perps.connect(userB).openPosition(true, encLong, toUSDC(20_000n), 0, 0);
      await coprocessor();
    }

    // Open a small SHORT (x < s) → entry impact is a gain;
    // Later close while skew still >0 → exit (long trade) is a cost; with same K they should cancel.
    const coll = toUSDC(8_000n);
    const notional = toUSDC(24_000n);
    const enc = await encryptUSDC(notional);

    const start = BigInt(await usdc.balanceOf(userA.address));
    await perps.connect(userA).openPosition(false, enc, coll, 0, 0);
    await coprocessor();

    // keep price/funding stable; tiny time passes to show it doesn’t matter
    await time.increase(60);
    await perps.pokeFunding();

    await perps.connect(userA).closePosition(2);
    await coprocessor();
    await perps.settlePositions([2]);

    const end = BigInt(await usdc.balanceOf(userA.address));

    const baseGross = coll;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;
    const actualNet = end - (start - coll);

    const diff = actualNet > baseNet ? actualNet - baseNet : baseNet - actualNet;
    expect(diff <= EPS, `skew-improving exit should net ≈ baseline; diff=${diff}`).to.eq(true);
  });

  it("Crossover exit (same K): exit delta is a rebate; net ≈ baseline when K equal", async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp } = await loadFixture(deployFixture);

    // Big pool
    await usdc.mint(lp.address, toUSDC(2_000_000n));
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256);
    await perps.connect(lp).lpDeposit(toUSDC(2_000_000n));

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(400_000n));
      await usdc.connect(u).approve(perpsAddr, hre.ethers.MaxUint256);
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u));
    }

    await feed.updateAnswer(PX0);

    // Start with s>0 by opening a big long on userB
    const encBias = await encryptUSDC(toUSDC(100_000n));
    await perps.connect(userB).openPosition(true, encBias, toUSDC(20_000n), 0, 0);
    await coprocessor();

    // UserA opens a big LONG x → s_exit for the future close is s+x. On exit (short trade),
    // Δ_exit = (s_exit - x)^2 - s_exit^2 = x^2 - 2 s_exit x < 0 → rebate.
    // With same K, entry cost magnitude == exit rebate magnitude → net ≈ baseline.
    const coll = toUSDC(12_000n);
    const notional = toUSDC(48_000n);
    const enc = await encryptUSDC(notional);

    const start = BigInt(await usdc.balanceOf(userA.address));
    await perps.connect(userA).openPosition(true, enc, coll, 0, 0);

    await coprocessor();

    await time.increase(60);
    await perps.pokeFunding();

    await perps.connect(userA).closePosition(2);
    await coprocessor();
    await perps.settlePositions([2]);

    const end = BigInt(await usdc.balanceOf(userA.address));

    const baseGross = coll;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;
    const actualNet = end - (start - coll);

    // Because exit is a rebate, actualNet should not be below baseline; with equal K it ≈ baseline.
    expect(actualNet >= baseNet - EPS, "exit rebate should not make net < baseline").to.eq(true);

    const diff = actualNet > baseNet ? actualNet - baseNet : baseNet - actualNet;
    console.log("diff: ", diff);
    expect(diff <= EPS, `crossover round-trip should net ≈ baseline when K equal; diff=${diff}`).to.eq(true);
  });

  it("Utilization drift: higher |funding| at exit → larger |K| → non-cancelling round-trip", async function () {
    const { perps, perpsAddr, usdc, feed, userA, userB, lp } = await loadFixture(deployFixture);

    // Big pool to reduce noise, but we will explicitly raise |funding| between entry and exit
    await usdc.mint(lp.address, toUSDC(3_000_000n));
    await usdc.connect(lp).approve(perpsAddr, hre.ethers.MaxUint256);
    await perps.connect(lp).lpDeposit(toUSDC(3_000_000n));

    for (const u of [userA, userB]) {
      await usdc.mint(u.address, toUSDC(500_000n));
      await usdc.connect(u).approve(perpsAddr, hre.ethers.MaxUint256);
      await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(u));
    }

    await feed.updateAnswer(PX0);

    // Keep funding ~0 for ENTRY
    // Create initial slight skew so impact is active
    const encBias = await encryptUSDC(toUSDC(80_000n));
    await perps.connect(userB).openPosition(true, encBias, toUSDC(15_000n), 0, 0);
    await coprocessor();

    // UserA opens LONG (entry cost at low K)
    const coll = toUSDC(10_000n);
    const notional = toUSDC(40_000n);
    const enc = await encryptUSDC(notional);

    const start = BigInt(await usdc.balanceOf(userA.address));
    await perps.connect(userA).openPosition(true, enc, coll, 0, 0);
    await coprocessor();

    // Now RAISE |funding| to shrink L and increase K for EXIT
    // We can bias skew further and commit a funding rate to raise |rate|
    {
      const encMore = await encryptUSDC(toUSDC(150_000n));
      await perps.connect(userB).openPosition(true, encMore, toUSDC(25_000n), 0, 0);
      await coprocessor();

      await ensurePositiveFunding(perps); // increases utilization proxy used in L
    }

    // Exit: close the long (short trade) under higher K ⇒ exit rebate magnitude > entry cost
    await perps.connect(userA).closePosition(2);
    await coprocessor();
    await perps.settlePositions([2]);

    const end = BigInt(await usdc.balanceOf(userA.address));

    const baseGross = coll;
    const baseFee   = closeFeeOn(baseGross);
    const baseNet   = baseGross - baseFee;
    const actualNet = end - (start - coll);

    // Because exit rebate is scaled by a larger K than entry cost, net > baseline.
    console.log("actualNet: ", actualNet);
    console.log("baseNet: ", baseNet);
    expect(actualNet > baseNet + EPS, `expected positive drift: actual ${actualNet} > baseline ${baseNet}`).to.eq(true);
  }).timeout(120000);
});
