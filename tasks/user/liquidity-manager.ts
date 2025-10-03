// tasks/user/liquidity-manager.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {ENDEX_ABI, ERC20_ABI, sleep} from "../utils";

/**
 * Interact with Endex LP:
 *  - Deposit: mint Underlying to signer (mock), approve Endex, lpDeposit(amount)
 *  - Withdraw: read lpSharesOf(signer), prompt amount or 'M' for max, lpWithdraw(shares)
 *
 * Optional params; all fall back to .env:
 *   ENDEX (endex address), Underlying (mintable token), LOCAL_PRIVATE_KEY (for txs), MODE (d/w), AMOUNT
 *
 * Examples:
 *   hardhat endex-liquidity --network localhost
 *   hardhat endex-liquidity --network localhost --mode d --amount "1,000"
 *   hardhat endex-liquidity --network localhost --mode w --amount M
 */

task("liquidity-manager", "Add/remove liquidity (deposit/withdraw) on Endex")
  .addOptionalParam("endex", "Endex address (env: ENDEX)")
  .addOptionalParam("underlying", "Underlying (MintableToken) address (env: Underlying)")
  .addOptionalParam("mode", "d=deposit, w=withdraw (env: MODE)")
  .addOptionalParam("amount", "Amount: Underlying for deposit (6d), shares for withdraw, or 'M' (env: AMOUNT)")
  .addOptionalParam("privateKey", "Local PK for txs (env: LOCAL_PRIVATE_KEY)")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers: hhEthers, network } = hre;

    // ----- Resolve config: prefer args, then .env -----
    const endexAddr = args.endex || process.env.ENDEX || "";
    const underlyingAddr  = args.underlying  || process.env.Underlying  || "";
    const modeArg   = (args.mode || process.env.MODE || "").toLowerCase();
    const amountArg = args.amount ?? process.env.AMOUNT;
    const pk        = args.privateKey || process.env.LOCAL_PRIVATE_KEY || "";

    if (!endexAddr || !underlyingAddr) {
      console.error(
        [
          "Missing contract addresses.",
          `  ENDEX : ${endexAddr || "(missing)"}`,
          `  Underlying  : ${underlyingAddr  || "(missing)"}`,
          "Provide via CLI args or .env.",
        ].join("\n")
      );
      return;
    }

    // ----- Provider & signer -----
    const provider = hhEthers.provider; // current hardhat --network provider
    let signer;
    if (pk) {
      signer = new ethers.Wallet(pk, provider);
    } else {
      [signer] = await hhEthers.getSigners();
    }
    const user = await signer.getAddress();

    const underlying = new ethers.Contract(underlyingAddr, ERC20_ABI, signer);
    const endex = new ethers.Contract(endexAddr, ENDEX_ABI, signer);

    // ----- Helpers -----
    const underlyingDecimals = 6;
    const shareDecimals = 6; // adjust if your shares use other decimals

    const parseAmountWithDecimals = (userInput: string, decimals: number): bigint => {
      const clean = userInput.replace(/[, _]/g, "").trim();
      if (!/^\d+(\.\d+)?$/i.test(clean)) throw new Error("Invalid number");
      const [int, frac = ""] = clean.split(".");
      const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
      return BigInt(int) * (10n ** BigInt(decimals)) + BigInt(fracPadded);
    };
    const formatAmountWithDecimals = (x: bigint, decimals: number): string => {
      const scale = 10 ** decimals;
      return (Number(x) / scale).toLocaleString(undefined, {
        minimumFractionDigits: Math.min(decimals, 6),
        maximumFractionDigits: Math.min(decimals, 6)
      });
    };

    // ----- Banner -----
    console.log(`\n=== Endex Liquidity — ${network.name} ===`);
    console.log(`Signer : ${user}`);
    console.log(`ENDEX  : ${endexAddr}`);
    console.log(`Underlying   : ${underlyingAddr}`);
    console.log("--------------------------------------\n");

    // ----- Prompt if missing -----
    const rl = readline.createInterface({ input, output });
    const ask = async (q: string) => (await rl.question(q)).trim();

    const mode = modeArg || (await ask("(D)eposit / (W)ithdraw? [d/w]: ")).toLowerCase();
    if (mode !== "d" && mode !== "w") {
      console.log("Please type 'd' or 'w'.");
      await rl.close();
      return;
    }

    if (mode === "d") {
      // ---- Deposit flow ----
      const amtStr = amountArg ?? await ask("Deposit amount (Underlying, 6d, e.g. 10 or 10,000): ");
      const amountUnderlying6 = parseAmountWithDecimals(String(amtStr), underlyingDecimals);

      // Mint mock Underlying to signer
      console.log(`Minting ${formatAmountWithDecimals(amountUnderlying6, underlyingDecimals)} Underlying to ${user}…`);
      const mintTx = await underlying.mint(user, amountUnderlying6);
      await mintTx.wait();
      await sleep(300);

      // Approve if needed
      const allowance: bigint = await underlying.allowance(user, endexAddr);
      if (allowance < amountUnderlying6) {
        console.log(`Approving ${formatAmountWithDecimals(amountUnderlying6, underlyingDecimals)} Underlying…`);
        const approveTx = await underlying.approve(endexAddr, amountUnderlying6);
        await approveTx.wait();
        await sleep(300);
      }

      // Deposit
      const tx = await endex.lpDeposit(amountUnderlying6);
      console.log(`Depositing ${formatAmountWithDecimals(amountUnderlying6, underlyingDecimals)} Underlying… tx=${tx.hash}`);
      await tx.wait();
      console.log("✅ Deposit complete.");

    } else {
      // ---- Withdraw flow ----
      const balanceShares: bigint = await endex.balanceOf(user);
      console.log(`Your LP shares: ${formatAmountWithDecimals(balanceShares, shareDecimals)} (raw=${balanceShares})`);

      if (balanceShares === 0n) {
        console.log("Nothing to withdraw.");
        await rl.close();
        return;
      }

      const inp = (amountArg ?? await ask(`Withdraw amount (shares, ${shareDecimals}d) or 'M' for max: `)).toString().trim();
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
      console.log("✅ Withdraw complete.");
    }

    await rl.close();
  });
