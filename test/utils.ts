// test/utils.ts
import hre from 'hardhat'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'

export const ONE_X18       = 10n ** 18n
export const EPS           = 50000n; // a few ~cents on typical sizes; tune if needed
export const CLOSE_FEE_BPS = 10n     // 0.1%
export const entryPrice    = 2000n;
export const PX0           = price(entryPrice);

export async function _deployFixture() {
    const [deployer, userA, userB, lp, keeper] = await hre.ethers.getSigners()

    // Mock USDC
    const USDC = await hre.ethers.getContractFactory('MintableToken')
    const usdc = await USDC.deploy('USDC', 'USDC', 6)
    const usdcAddr = await usdc.getAddress()

    // Chainlink mock @ $2000 (8d)
    const Feed = await hre.ethers.getContractFactory('MockV3Aggregator')
    const feed = await Feed.deploy(8, PX0)
    const feedAddr = await feed.getAddress()

    // Endex
    const Endex = await hre.ethers.getContractFactory('EndexHarness')
    const endex = await Endex.deploy(usdcAddr, feedAddr)
    const endexAddr = await endex.getAddress()

    return { endex, endexAddr, usdc, feed, deployer, userA, userB, lp, keeper }
}

// Baseline payout net (no funding, no price impact) used for direction checks.
// PnL = size * (P-E)/E
export function baselineNetPayout(
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
export function baselineNetPayoutBasic(collateral: bigint): bigint {
  const fee = (collateral * CLOSE_FEE_BPS) / 10_000n
  return collateral - fee
}

export function closeFeeOn(gross: bigint) {
  // Your CLOSE_FEE_BPS is 10; divisor 10_000
  return (gross * 10n) / 10_000n;
}

// CoFHE decrypts async
export async function coprocessor(ms = 1_000) {
  console.log("waiting for coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}

export async function decryptEint256(e : any) {
    const val = await cofhejs.unseal(e.val, FheTypes.Uint256);
    const sign = await cofhejs.unseal(e.sign, FheTypes.Bool);

    const v = (val.data == null) ? 0 : val.data;

    // make value negative if sign is false
    return BigInt(!sign.data ? -1 : 1) * BigInt(v);
}

export async function decryptEuint256(e : any) {
    const val = await cofhejs.unseal(e, FheTypes.Uint256);
    console.log(val.data);
    const v = (val.data == null) ? 0 : val.data;
    return BigInt(v);
}

/** Encrypt an *invalid* range such that (low + BUFFER) >= high so _validateRange() fails */
export async function encInvalidRange(bufferE8: bigint) {
  // Pick low = 2000e8; high = low + buffer - 1 ⇒ invalid
  const lowPlain  = PX0
  const highPlain = PX0 + bufferE8 - 1n
  const low  = await encryptUint256(lowPlain)
  const high = await encryptUint256(highPlain)
  return [low, high] as const
}

/** Encrypt a valid ±$1 price band around ${priceIn} (8d), wide enough to satisfy BUFFER */
export async function encValidRange(priceIn : bigint) {
  const low  = await encryptUint256(price(priceIn - 1n))
  const high = await encryptUint256(price(priceIn + 1n))
  return [low, high]
}

export async function encryptUint256(val: bigint) {
  const [enc] = await hre.cofhe.expectResultSuccess(
    cofhejs.encrypt([Encryptable.uint256(val)])
  );
  return enc;
}

export async function encryptBool(val: boolean) {
  const [enc] = await hre.cofhe.expectResultSuccess(
    cofhejs.encrypt([Encryptable.bool(val)])
  );
  return enc;
}

// Request an open, process until opened, expect valid opening
export async function openPosition({
    endex, keeper, user, direction, size, collateral
} : any) {
      let range = await encValidRange(entryPrice);
      console.log("open position request..");
      await endex.connect(user).openPositionRequest(direction, size, range, collateral);
      await coprocessor();

      const id = Number(await endex.nextPositionId())-1;

      console.log("Process state from Requested -> Pending..");
      await endex.connect(keeper).process([id]);
      await coprocessor();

      console.log("Process state from Pending -> Open..");
      await endex.connect(keeper).process([id]);
      await coprocessor();

      const status = parseStatus((await endex.getPosition(id)).status);
      console.log("Status: ", status);
      if(status != "Open") {
          throw new Error("Status not Open");
      }
}

export function parseStatus(status : BigInt) {
    switch(status) {
    case 0n:
        return "Requested"
    case 1n:
        return "Pending"
    case 2n:
        return "Open"
    case 3n:
        return "Awaiting Settlement"
    case 4n:
        return "Liquidated"
    case 5n:
        return "Closed"
    default:
        throw new Error("Unknown Status")
    }
}

export function parseCloseCause(status : BigInt) {
    switch(status) {
    case 0n:
        return "User Close"
    case 1n:
        return "Liquidation"
    case 2n:
        return "Take Profit"
    case 3n:
        return "Stop Loss"
    default:
        throw new Error("Unknown Status")
    }
}

export function price(n: bigint) { 
    return n * 10n ** 8n // 8 decimals
}

// Request an open, then run one keeper process pass (Requested → refund or Pending).
export async function requestPosition({
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

export function toUnderlying(n: bigint) { 
    return n * 10n ** 6n // 6 decimals
}
