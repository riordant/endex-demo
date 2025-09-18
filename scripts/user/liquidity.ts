/* scripts/user/liquidity.ts
   CLI for adding/removing liquidity on Endex:
     - (D)eposit: prompt for amount (USDC, 6 decimals), mint mock USDC, approve Endex, lpDeposit(amount)
     - (W)ithdraw: detect user's share balance, prompt for amount or Max, lpWithdraw(shares)

   ENV (optional):
     LOCAL_RPC=http://127.0.0.1:8545
     PRIVATE_KEY=0x...
     DEPLOY_DIR=deployments/localcofhe
     USDC=0x...
     ENDEX=0x...

   Run:
     ts-node scripts/user/liquidity.ts
*/

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline/promises";
import { loadAbiFromArtifact } from "../utils/abi";
import { stdin as input, stdout as output } from "process";


async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------- opts / helpers ----------
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

function loadAddress(dir: string, name: string): string | undefined {
  try {
    const p = path.join(process.cwd(), dir, `${name}.json`);
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    return json.address as string;
  } catch {
    return undefined;
  }
}

function parseAmountWithDecimals(userInput: string, decimals: number): bigint {
  const clean = userInput.replace(/[, _]/g, "").trim();
  if (!/^\d+(\.\d+)?$/i.test(clean)) throw new Error("Invalid number");
  const [int, frac = ""] = clean.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int) * (10n ** BigInt(decimals)) + BigInt(fracPadded);
}
function formatAmountWithDecimals(x: bigint, decimals: number): string {
  const scale = 10 ** decimals;
  return (Number(x) / scale).toLocaleString(undefined, { minimumFractionDigits: Math.min(decimals, 6), maximumFractionDigits: Math.min(decimals, 6) });
}

// ---------- ABIs ----------
const ENDEX_ABI = loadAbiFromArtifact("contracts/Endex.sol/Endex.json");
const ERC20_ABI = loadAbiFromArtifact("contracts/mocks/MintableToken.sol/MintableToken.json");

async function detectShareBalance(endex: ethers.Contract, user: string): Promise<bigint> {
  // try a few shapes
  return BigInt(await endex.lpSharesOf(user));
}

async function main() {
  const opts = getOpts();
  const provider = new ethers.JsonRpcProvider(opts.rpc);
  const wallet = new ethers.Wallet(
    opts.pk || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    provider
  );
  const user = await wallet.getAddress();

  const usdcAddr = opts.usdc || loadAddress(opts.deployDir, "USDC");
  const endexAddr = opts.endex || loadAddress(opts.deployDir, "Endex");
  if (!usdcAddr || !endexAddr) {
    throw new Error(`Missing USDC/Endex addresses. Ensure ${opts.deployDir}/{USDC,Endex}.json or set ENDEX/USDC envs.`);
  }

  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, wallet);
  const endex = new ethers.Contract(endexAddr, ENDEX_ABI, wallet);

  // fixed: USDC uses 6 decimals
  const usdcDecimals = 6;
  const shareDecimals = 6;

  console.log(`RPC   : ${opts.rpc}`);
  console.log(`Signer: ${user}`);
  console.log(`USDC  : ${usdcAddr} (decimals=${usdcDecimals})`);
  console.log(`Endex : ${endexAddr} (shareDecimals≈${shareDecimals})\n`);

  const rl = readline.createInterface({ input, output });
  const mode = (await rl.question("(D)eposit / (W)ithdraw? [d/w]: ")).trim().toLowerCase();

  try {
    if (mode === "d") {
      // ---- Deposit flow ----
      const amtStr = (await rl.question("Deposit amount (USDC, 6d, e.g. 10 or 10,000): ")).trim();
      const amountUSDC6 = parseAmountWithDecimals(amtStr, usdcDecimals);

      // mint to user (mock)
      console.log("Minting " + amtStr + " USDC for " + user + "…");
      const mintTx = await usdc.mint(user, amountUSDC6);
      await mintTx.wait();
      await sleep(500);

      // approve if needed
      const allowance: bigint = await usdc.allowance(user, endexAddr);
      if (allowance < amountUSDC6) {
        console.log(`Approving ${formatAmountWithDecimals(amountUSDC6, usdcDecimals)} USDC…`);
        const approveTx = await usdc.approve(endexAddr, amountUSDC6);
        await approveTx.wait();
        await sleep(500);
      }

      // deposit
      const tx = await endex.lpDeposit(amountUSDC6);
      console.log(`Depositing ${formatAmountWithDecimals(amountUSDC6, usdcDecimals)} USDC… tx=${tx.hash}`);
      await tx.wait();
      await sleep(500);
      console.log("✅ Deposit complete.");

    } else if (mode === "w") {
      // ---- Withdraw flow ----
      const balanceShares = await detectShareBalance(endex, user);
      console.log(`Your LP shares: ${formatAmountWithDecimals(balanceShares, shareDecimals)} (raw=${balanceShares})`);

      if (balanceShares === 0n) {
        console.log("Nothing to withdraw.");
        await rl.close();
        return;
      }

      const inp = (await rl.question(`Withdraw amount (shares, ${shareDecimals}d) or 'M' for max: `)).trim();
      let amtShares: bigint;
      if (inp.toLowerCase() === "m") {
        amtShares = balanceShares;
      } else {
        const parsed = parseAmountWithDecimals(inp, shareDecimals);
        if (parsed <= 0n || parsed > balanceShares) {
          console.log("Amount out of range.");
          await rl.close();
          return;
        }
        amtShares = parsed;
      }

      const tx = await endex.lpWithdraw(amtShares);
      console.log(`Withdrawing ${formatAmountWithDecimals(amtShares, shareDecimals)} shares… tx=${tx.hash}`);
      await tx.wait();
      await sleep(500);
      console.log("✅ Withdraw complete.");

    } else {
      console.log("Please type 'd' or 'w'.");
    }
  } finally {
    await rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
