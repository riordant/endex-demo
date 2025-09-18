/* scripts/user/trading.ts
   CLI for opening OR closing a position on Endex (IEndex interface exact).
   - OPEN: mints mock USDC, approves, seals size (USDC 6d × leverage), calls openPosition
   - CLOSE: scans positions owned by signer with Status.Open, prompts to choose, calls closePosition

   ENV (optional):
     LOCAL_RPC=http://127.0.0.1:8545
     PRIVATE_KEY=0x...
     DEPLOY_DIR=deployments/localcofhe
     USDC=0x...
     ENDEX=0x...

   Run:
     ts-node scripts/user/trading.ts
*/

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { loadAbiFromArtifact } from "../utils/abi";
import { cofhejs, Encryptable, EncryptStep } from 'cofhejs/node'
import { cofhejs_initializeWithHardhatSigner } from 'cofhe-hardhat-plugin'

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}


type Opts = {
  rpc: string;
  pk?: string;
  deployDir: string;
  usdc?: string;
  endex?: string;
};

function getOpts(): Opts {
  return {
    rpc: process.env.LOCAL_RPC || "http://127.0.0.1:8545",
    pk: process.env.PRIVATE_KEY,
    deployDir: process.env.DEPLOY_DIR || "deployments/localcofhe",
    usdc: process.env.USDC,
    endex: process.env.ENDEX,
  };
}

function loadAddress(deployDir: string, name: string): string | undefined {
  try {
    const p = path.join(process.cwd(), deployDir, `${name}.json`);
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    return json.address as string;
  } catch {
    return undefined;
  }
}

async function encrypt(val : BigInt) {
	const logState = (state: EncryptStep) => {
		console.log(`Log Encrypt State :: ${state}`)
	}

	const encryptedValue = await cofhejs.encrypt([Encryptable.uint256(val)] as const, logState)

    console.log("encryptedValue: ", encryptedValue);

	if (encryptedValue && encryptedValue.data) {
		return encryptedValue.data[0]
    } else {
        throw new Error("failed to encrypt.");
    }
}

function parseUsd6(userInput: string): bigint {
  const clean = userInput.replace(/[, _]/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Invalid number");
  const [int, frac = ""] = clean.split(".");
  const frac6 = (frac + "000000").slice(0, 6);
  return BigInt(int) * 1_000_000n + BigInt(frac6);
}
function fmtUSD6(usdc6: bigint) {
  return (Number(usdc6) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPriceE8(p: bigint) {
  return (Number(p) / 1e8).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pad(s: string, n: number) { const t = String(s); return t.length >= n ? t.slice(0, n) : t + " ".repeat(n - t.length); }

// ---- ABIs ----
// USDC mock (ERC20 + mint)
const ENDEX_ABI = loadAbiFromArtifact("contracts/Endex.sol/Endex.json");
const ERC20_ABI = loadAbiFromArtifact("contracts/mocks/MintableToken.sol/MintableToken.json");

// ---- Types mirrored from IEndex.Position (only the parts we display/use) ----
type PositionLite = {
  id: bigint;
  owner: string;
  isLong: boolean;
  status: number;           // 0 Open, 1 AwaitingSettlement, 2 Liquidated, 3 Closed
  collateral: bigint;       // USDC 6d
  entryPrice: bigint;       // 8 decimals
  settlementPrice: bigint;  // 8 decimals
};

// ---- Fetch & filter ----
async function fetchPosition(endex: ethers.Contract, id: bigint): Promise<PositionLite | null> {
  try {
    const p = await endex.getPosition(id);
    const o = p as any;
    return {
      id,
      owner: String(o.owner),
      isLong: Boolean(o.isLong),
      status: Number(o.status),
      collateral: BigInt(o.collateral),
      entryPrice: BigInt(o.entryPrice),
      settlementPrice: BigInt(o.settlementPrice),
    };
  } catch {
    return null;
  }
}

async function listUserOpenPositions(endex: ethers.Contract, user: string): Promise<PositionLite[]> {
  const nextId: bigint = await endex.nextPositionId();
  const out: PositionLite[] = [];
  for (let id = 1n; id < nextId; id++) {
    const p = await fetchPosition(endex, id);
    if (!p) continue;
    if (p.owner.toLowerCase() !== user.toLowerCase()) continue;
    if (p.status === 0) out.push(p);
  }
  return out;
}

// ---- OPEN ----
async function flowOpen(rl: readline.Interface, usdc: ethers.Contract, endex: ethers.Contract, user: string) {
  console.log("\n=== Open Position ===");

  // collateral
  const collateralStr = (await rl.question("Enter collateral (USDC, 6 decimals, e.g. 10,000): ")).trim();
  const collateralUSDC6 = parseUsd6(collateralStr);

  // side
  const side = (await rl.question("Enter side: long(l) / short(s): ")).trim().toLowerCase();
  if (!["l", "s"].includes(side)) throw new Error("Invalid side; use 'l' or 's'");
  const isLong = side === "l";

  // leverage
  const levNum = Number((await rl.question("Enter leverage (1-5): ")).trim());
  if (!Number.isFinite(levNum) || levNum < 1 || levNum > 5) throw new Error("Invalid leverage; must be 1-5");

  // compute size (USDC 6d)
  const sizeUSDC6 = collateralUSDC6 * BigInt(levNum);

  // seal InEuint256
  const sizeEnc = await encrypt(sizeUSDC6);

  // mint & approve
  const mintTx = await usdc.mint(user, collateralUSDC6);
  await mintTx.wait();
  await sleep(500);

  const allowance: bigint = await usdc.allowance(user, endex.target as string);
  if (allowance < collateralUSDC6) {
    const approveTx = await usdc.approve(endex.target as string, collateralUSDC6);
    await approveTx.wait();
    await sleep(500);
  }

  console.log(`\nOpening: ${isLong ? "LONG" : "SHORT"}  size=$${fmtUSD6(sizeUSDC6)}  collateral=$${fmtUSD6(collateralUSDC6)}  lev=${levNum}x`);
  const tx = await endex.openPosition(isLong, sizeEnc, collateralUSDC6, 0, 0);
  console.log(`→ tx: ${tx.hash}`);
  await tx.wait();
  await sleep(500);
  console.log("✅ Position opened.\n");
}

// ---- CLOSE ----
async function flowClose(rl: readline.Interface, endex: ethers.Contract, user: string) {
  console.log("\n=== Close Position ===");

  const list = await listUserOpenPositions(endex, user);
  if (!list.length) {
    console.log("No OPEN positions owned by this signer.\n");
    return;
  }

  console.log("\nYour OPEN positions:");
  console.log("  " + pad("Idx", 5) + pad("PosID", 10) + pad("Side", 8) + pad("Collateral(USDC)", 20) + pad("EntryPx", 16));
  list.forEach((p, i) => {
    console.log(
      "  " +
      pad(String(i), 5) +
      pad(String(p.id), 10) +
      pad(p.isLong ? "LONG" : "SHORT", 8) +
      pad(fmtUSD6(p.collateral), 20) +
      pad("$" + fmtPriceE8(p.entryPrice), 16)
    );
  });

  const idx = Number((await rl.question("\nEnter index to close (e.g., 0): ")).trim());
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) throw new Error("Invalid index.");
  const chosen = list[idx];

  const tx = await endex.closePosition(chosen.id);
  console.log(`Submitting closePosition(${chosen.id})… tx=${tx.hash}`);
  await tx.wait();
  console.log("✅ Close submitted. (Will move to settlement path as your keepers run.)\n");
}

// ---- main ----
async function main() {
  const opts = getOpts();

  console.log("opts: ", opts);
  const provider = new ethers.JsonRpcProvider(opts.rpc);

  const wallet = new ethers.Wallet(
    opts.pk || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    provider
  );
  const user = await wallet.getAddress();
  await cofhejs_initializeWithHardhatSigner(wallet)

  const usdcAddr = opts.usdc || loadAddress(opts.deployDir, "USDC");
  const endexAddr = opts.endex || loadAddress(opts.deployDir, "Endex");
  if (!usdcAddr || !endexAddr) throw new Error(`Missing USDC/Endex addresses. Ensure ${opts.deployDir}/{USDC,Endex}.json or set env vars.`);

  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, wallet);
  const endex = new ethers.Contract(endexAddr, ENDEX_ABI, wallet);

  console.log(`RPC   : ${opts.rpc}`);
  console.log(`Signer: ${user}`);
  console.log(`USDC  : ${usdcAddr}`);
  console.log(`Endex : ${endexAddr}\n`);

  const rl = readline.createInterface({ input, output });
  const mode = (await rl.question("Open or Close? [o/c]: ")).trim().toLowerCase();

  try {
    if (mode === "o") {
      await flowOpen(rl, usdc, endex, user);
    } else if (mode === "c") {
      await flowClose(rl, endex, user);
    } else {
      console.log("Please type 'o' or 'c'.");
    }
  } finally {
    await rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
