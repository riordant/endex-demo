import {cofhejs, Encryptable, EncryptStep, FheTypes} from 'cofhejs/node'
import fs from 'fs'
import path from 'path'

// Directory to store deployed contract addresses
const DEPLOYMENTS_DIR = path.join(__dirname, '../deployments')

// Ensure the deployments directory exists
if (!fs.existsSync(DEPLOYMENTS_DIR)) {
	fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
}

// Helper to get deployment file path for a network
const getDeploymentPath = (network: string) => path.join(DEPLOYMENTS_DIR, `${network}/addresses.json`)

// Helper to save deployment info
export const saveDeployment = (network: string, contractName: string, address: string) => {
	const deploymentPath = getDeploymentPath(network)

	let deployments: Record<string, string> = {}
	if (fs.existsSync(deploymentPath)) {
		deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, string>
	}

	deployments[contractName] = address

	fs.writeFileSync(deploymentPath, JSON.stringify(deployments, null, 2))
	console.log(`Deployment saved to ${deploymentPath}`)
}

// Helper to get deployment info
export const getDeployment = (network: string, contractName: string): string | null => {
	const deploymentPath = getDeploymentPath(network)

	if (!fs.existsSync(deploymentPath)) {
		return null
	}

	const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, string>
	return deployments[contractName] || null
}


export function parseUsd6(userInput: string): bigint {
  const clean = userInput.replace(/[, _]/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Invalid number");
  const [int, frac = ""] = clean.split(".");
  const frac6 = (frac + "000000").slice(0, 6);
  return BigInt(int) * 1_000_000n + BigInt(frac6);
}
export function fmtPriceE8(p: bigint) {
  return (Number(p) / 1e8).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function pad(s: string, n: number) { const t = String(s); return t.length >= n ? t.slice(0, n) : t + " ".repeat(n - t.length); }

export async function encryptUint256(val: bigint) {
  const logState = (state: EncryptStep) => console.log(`Encrypt State :: ${state}`);
  const res = await cofhejs.encrypt([Encryptable.uint256(val)] as const, logState);
  if (!res?.data?.[0]) throw new Error("Failed to encrypt (cofhejs).");
  return res.data[0];
}

export async function decryptEuint256(e : any) {
    const val = await cofhejs.unseal(e, FheTypes.Uint256);
    console.log("val.data:", val.data);
    const v = (val.data == null) ? 0 : val.data;
    return BigInt(v);
}

export async function unsealEint256(e : any) {
    const val = await cofhejs.unseal(e.val, FheTypes.Uint256);
    const sign = await cofhejs.unseal(e.sign, FheTypes.Bool);

    const v = (val.data == null) ? 0 : val.data;

    // make value negative if sign is false
    return BigInt(!sign.data ? -1 : 1) * BigInt(v);
}


export async function encryptBool(val: boolean) {
  const logState = (state: EncryptStep) => console.log(`Encrypt State :: ${state}`);
  const res = await cofhejs.encrypt([Encryptable.bool(val)] as const, logState);
  if (!res?.data?.[0]) throw new Error("Failed to encrypt (cofhejs).");
  return res.data[0];
}

export async function decryptBool(val: any) {
    const isLongRaw = await cofhejs.unseal(val, FheTypes.Bool);
    if (isLongRaw.success) {
      return Boolean(isLongRaw.data);
    }
    return false;
}

// CoFHE decrypts async
export async function coprocessor(ms = 1_000) {
  //console.log("waiting for coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}


export const ENDEX_ABI = loadAbiFromArtifact("contracts/Endex.sol/Endex.json");
export const AGGREGATOR_ABI = loadAbiFromArtifact("contracts/mocks/MockV3Aggregator.sol/MockV3Aggregator.json");
export const ERC20_ABI = loadAbiFromArtifact("contracts/mocks/MintableToken.sol/MintableToken.json");

/** Reads Hardhat artifact JSON and returns its `abi` array. */
export function loadAbiFromArtifact(relativeArtifactPath: string): any[] {
  // relativeArtifactPath examples:
  //  "contracts/Endex.sol/Endex.json"
  //  "contracts/mocks/MintableToken.sol/MintableToken.json"
  const full = path.join(process.cwd(), "artifacts", relativeArtifactPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Artifact not found: ${full}. Did you run \`hardhat compile\`?`);
  }
  const json = JSON.parse(fs.readFileSync(full, "utf8"));
  if (!json.abi) {
    throw new Error(`No 'abi' key in artifact: ${full}`);
  }
  return json.abi;
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

export function bpPerHourFromX18(ratePerSecX18: bigint): number {
  // bp/hr = rate * 3600 * 1e4
  const r = Number(ratePerSecX18) / 1e18;
  return r * 3600 * 1e4;
}
export function bpPerDayFromX18(ratePerSecX18: bigint): number {
  // bp/day = rate * 86400 * 1e4
  const r = Number(ratePerSecX18) / 1e18;
  return r * 86400 * 1e4;
}

export function fmtPnl(pnl: bigint): string {
  let pnlStr = fmtUSD6(pnl);
  return (pnlStr.indexOf('-') > -1) 
      ? `-\$${pnlStr.substring(1)}` 
      : `+\$${pnlStr}`;
}


export const usd = (x: number, d = 2) =>
  x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export function fmtUSD6(underlying6: bigint): string {
  return (Number(underlying6) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmt(num: number, frac = 2): string {
  return num.toLocaleString(undefined, { minimumFractionDigits: frac, maximumFractionDigits: frac });
}

export function clearScreen() {
  // ANSI: ESC[2J clear screen, ESC[H cursor home
  process.stdout.write("\x1b[2J\x1b[H");
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export function scaleToDecimals(value: bigint, from: number, to: number): bigint {
  if (from === to) return value;
  if (from < to) {
    const mul = 10n ** BigInt(to - from);
    return value * mul;
  } else {
    const div = 10n ** BigInt(from - to);
    return value / div;
  }
}
