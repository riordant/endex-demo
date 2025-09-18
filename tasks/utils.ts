import {cofhejs, Encryptable, EncryptStep} from 'cofhejs/node'
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
export function fmtUSD6(usdc6: bigint) {
  return (Number(usdc6) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtPriceE8(p: bigint) {
  return (Number(p) / 1e8).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function pad(s: string, n: number) { const t = String(s); return t.length >= n ? t.slice(0, n) : t + " ".repeat(n - t.length); }

export async function encryptUint256(val: bigint) {
  const logState = (state: EncryptStep) => console.log(`Encrypt State :: ${state}`);
  const res = await cofhejs.encrypt([Encryptable.uint256(val)] as const, logState);
  if (!res?.data?.[0]) throw new Error("Failed to encrypt (cofhejs).");
  return res.data[0]; // bytes
}

// CoFHE decrypts async
export async function coprocessor(ms = 10_000) {
  console.log("waiting for coprocessor..")
  return new Promise((r) => setTimeout(r, ms))
}
