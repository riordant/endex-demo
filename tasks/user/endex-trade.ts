// tasks/user/endex-trade-v2.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { cofhejs_initializeWithHardhatSigner } from "cofhe-hardhat-plugin";

import {
  AGGREGATOR_ABI,
  coprocessor,               // unchanged helper (noop here; useful if you want manual nudges)
  decryptBool,
  encryptBool,
  encryptUint256,
  fmtPriceE8,
  fmtUSD6,
  getDeployment,
  pad,
  parseUsd6,
  sleep,
} from "../utils";

/**
 * Interactive trader:
 * - Adds entry price RANGE (encrypted) to openPositionRequest
 * - Prints current oracle price and supports quick 'C' (±$1.00) range
 * - Submits open, then WAITS until position becomes OPEN (or gets removed)
 * - Submits close, then WAITS until position becomes CLOSED
 *
 * Usage:
 *   hardhat endex-trade-v2 --network localhost
 *   hardhat endex-trade-v2 --network localhost --mode o --collateral "1,000" --side l --lev 5
 */
task("endex-trade", "Open or close a position (with encrypted entry range + state waiter)")
  .addOptionalParam("mode", "o=open, c=close")
  .addOptionalParam("collateral", "Collateral Underlying (6d), e.g. 10,000")
  .addOptionalParam("side", "l=long, s=short")
  .addOptionalParam("lev", "Leverage 1-5")
  .addOptionalParam("endex", "Override Endex address")
  .addOptionalParam("underlying", "Override Underlying address")
  .addOptionalParam("aggregator", "Override AggregatorV3 address (for price)")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    // ---- Signer + CoFHE init ----
    const [signer] = await ethers.getSigners();
    console.log(`\nNetwork: ${network.name}`);
    console.log(`Signer : ${signer.address}`);
    await cofhejs_initializeWithHardhatSigner(hre, signer); // sets CRS / pubkey

    // ---- Resolve addresses ----
    const endexAddr = args.endex || getDeployment(network.name, "Endex");
    const underlyingAddr  = args.underlying  || getDeployment(network.name, "Underlying");
    const aggAddr   = args.aggregator || getDeployment(network.name, "PriceFeed");
    if (!endexAddr || !underlyingAddr || !aggAddr) {
      console.error("Missing Endex/Underlying/Aggregator deployment. Provide --endex/--underlying/--aggregator or deploy first.");
      return;
    }
    console.log(`Endex : ${endexAddr}`);
    console.log(`Underlying  : ${underlyingAddr}`);
    console.log(`Oracle: ${aggAddr}\n`);

    // ---- Bind contracts ----
    const endex = await ethers.getContractAt("Endex", endexAddr, signer);
    const underlying  = await ethers.getContractAt("MintableToken", underlyingAddr, signer);
    const aggregator = new ethers.Contract(aggAddr, AGGREGATOR_ABI, ethers.provider);

    // ---- Helpers (status parsing for this script) ----
    // Endex status mapping in this repo (see contracts / tests):
    // 0=Requested, 1=Pending, 2=Open, 3=AwaitingSettlement, 4=Liquidated, 5=Closed
    const statusStr = (s: number) =>
      ["Requested","Pending","Open","Awaiting Settlement","Liquidated","Closed"][s] ?? `?(${s})`;

    // Generic waiter used by both OPEN and CLOSE flows
    async function waitForPosition(
      id: bigint,
      mode: "open" | "close",
      pollMs = 2_000
    ): Promise<"open" | "closed" | "removed" | "timeout"> {
      const t0 = Date.now();
      const TIMEOUT_MS = 5 * 60_000; // 5 minutes hard cap (tweak if you'd like)

      while (true) {
        let p: any;
        try { p = await endex.getPosition(id); } catch { /* retry */ }

        const st = Number(p?.status ?? -1);
        const stLabel = statusStr(st);
        const removed = Boolean(p?.validity?.removed ?? false);

        if (mode === "open") {
          console.log(`[wait-open] id=${id}  state=${stLabel}  removed=${removed}`);
          // success: OPEN (2) and not removed
          if (st === 2 && !removed) return "open";
          // if still Requested (0) but removed=true, user funds returned; stop waiting
          if (st === 0 && removed) return "removed";
        } else {
          console.log(`[wait-close] id=${id}  state=${stLabel}`);
          // success: CLOSED (5)
          if (st === 5) return "closed";
        }

        if (Date.now() - t0 > TIMEOUT_MS) {
          console.log("Wait timeout reached.");
          return "timeout";
        }
        await sleep(pollMs);
      }
    }

    // Readline prompt
    const rl = readline.createInterface({ input, output });
    const ask = async (q: string) => (await rl.question(q)).trim();

    const mode = (args.mode || await ask("Open or Close? [o/c]: ")).toLowerCase();
    if (mode !== "o" && mode !== "c") {
      console.log("Please type 'o' or 'c'.");
      await rl.close();
      return;
    }

    if (mode === "o") {
      // ---------- OPEN FLOW ----------
      const collateralStr = args.collateral || await ask("Enter collateral (Underlying, 6d, e.g. 10,000): ");
      const collateralUnderlying6 = parseUsd6(collateralStr);

      const side = (args.side || await ask("Enter side: long(l) / short(s): ")).toLowerCase();
      if (!["l", "s"].includes(side)) throw new Error("Invalid side; use 'l' or 's'");
      const isLong = side === "l";

      const levNum = Number(args.lev || await ask("Enter leverage (1-5): "));
      if (!Number.isFinite(levNum) || levNum < 1 || levNum > 5) throw new Error("Invalid leverage; must be 1-5");

      const sizeUnderlying6 = collateralUnderlying6 * BigInt(levNum);

      // --- Show current price; support quick 'C' range ---
      let currentE8 = 0n;
      try {
        const [ , answer ] = await aggregator.latestRoundData(); // Chainlink-like interface (latestRoundData). Check updatedAt if you care about staleness. 
        currentE8 = BigInt(answer);
      } catch {}
      console.log(`Current price: $${fmtPriceE8(currentE8)} (8 decimals)`);
      const rangeInput = await ask(
        "Entry price range: press 'C' for ±$1.00 around current, or enter 'min,max' in dollars (e.g. 1999,2001): "
      );

      // Build encrypted range
      let lowE8: bigint, highE8: bigint;
      const ONE_DOLLAR_E8 = 100_000_000n; // $1.00 in 8d

      if (/^c$/i.test(rangeInput)) {
        if (currentE8 === 0n) {
          await rl.close();
          throw new Error("Oracle price not available for quick 'C' range.");
        }
        lowE8  = currentE8 - ONE_DOLLAR_E8;
        highE8 = currentE8 + ONE_DOLLAR_E8;
      } else {
        // parse "min,max" dollars
        const m = rangeInput.split(",").map(s => s.trim());
        if (m.length !== 2) { await rl.close(); throw new Error("Invalid range input. Expected 'min,max' or 'C'."); }
        const toE8 = (d: string) => {
          if (!/^\d+(\.\d+)?$/.test(d)) throw new Error("Bad number in range.");
          const [int, frac=""] = d.split(".");
          const frac8 = (frac + "00000000").slice(0, 8);
          return BigInt(int) * 100_000_000n + BigInt(frac8);
        };
        lowE8  = toE8(m[0]);
        highE8 = toE8(m[1]);
        if (lowE8 >= highE8) { await rl.close(); throw new Error("Range must be strictly increasing: min < max."); }
      }

      // Encrypt inputs
      const sizeEnc = await encryptUint256(sizeUnderlying6);
      const dirEnc  = await encryptBool(isLong);
      const lowEnc  = await encryptUint256(lowE8);
      const highEnc = await encryptUint256(highE8);

      // Mint & approve collateral
      {
        const mintTx = await underlying.mint(signer.address, collateralUnderlying6);
        await mintTx.wait();
        const allowance = await underlying.allowance(signer.address, endexAddr);
        if (allowance < collateralUnderlying6) {
          const approveTx = await underlying.approve(endexAddr, collateralUnderlying6);
          await approveTx.wait();
        }
      }

      console.log(
        `\nOpening: ${isLong ? "LONG" : "SHORT"}  size=$${fmtUSD6(sizeUnderlying6)}  collateral=$${fmtUSD6(collateralUnderlying6)}  lev=${levNum}x\n` +
        `Range  : [$${fmtPriceE8(lowE8)}, $${fmtPriceE8(highE8)}]`
      );

      // Submit request
      const tx = await (endex as any).openPositionRequest(
        dirEnc,
        sizeEnc,
        { low: lowEnc, high: highEnc },   // InRange
        collateralUnderlying6
      );
      console.log(`→ openPositionRequest tx=${tx.hash}`);
      await tx.wait();

      // New position id is nextPositionId-1
      const nextId: bigint = await (endex as any).nextPositionId();
      const newId = nextId - 1n;

      // Wait until it becomes OPEN (the position-keeper will call process([...]))
      console.log(`\nWaiting for position #${newId} to OPEN...`);
      const res = await waitForPosition(newId, "open", 2_000);
      if (res === "open") {
        console.log(`✅ Position #${newId} is OPEN.`);
      } else if (res === "removed") {
        console.log(`⚠️  Position #${newId} request was rejected & funds returned (removed=true).`);
      } else {
        console.log(`⚠️  Position #${newId} did not open in time.`);
      }

    } else {
      // ---------- CLOSE FLOW ----------
      console.log("\n=== Close Position ===");

      // Collect user's OPEN positions (status==2)
      const nextId: bigint = await endex.nextPositionId();
      const ownedOpen: Array<{ id: bigint; isLong: boolean; collateral: bigint; entryPrice: bigint }> = [];
      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id);
          const owner: string = p.owner;
          const status: number = Number(p.status);
          if (owner?.toLowerCase() === signer.address.toLowerCase() && status === 2) {
            ownedOpen.push({
              id,
              isLong: await decryptBool(p.isLong),
              collateral: BigInt(p.collateral),
              entryPrice: BigInt(p.entryPrice),
            });
          }
        } catch {}
      }

      if (!ownedOpen.length) {
        console.log("No OPEN positions owned by this signer.");
        await rl.close();
        return;
      }

      console.log("\nYour OPEN positions:");
      console.log("  " + pad("Idx", 5) + pad("PosID", 10) + pad("Side", 8) + pad("Collateral(Underlying)", 20) + pad("EntryPx", 16));
      ownedOpen.forEach((p, i) => {
        console.log(
          "  " +
          pad(String(i), 5) +
          pad(String(p.id), 10) +
          pad(p.isLong ? "LONG" : "SHORT", 8) +
          pad("$" + fmtUSD6(p.collateral), 20) +
          pad("$" + fmtPriceE8(p.entryPrice), 16)
        );
      });

      const idxStr = await ask("\nEnter index to close (e.g., 0): ");
      const idx = Number(idxStr);
      if (!Number.isInteger(idx) || idx < 0 || idx >= ownedOpen.length) {
        await rl.close();
        throw new Error("Invalid index.");
      }
      const chosen = ownedOpen[idx];

      // Submit close and then just wait — the position-keeper will process → settle
      const tx1 = await endex.closePosition(chosen.id);
      console.log(`Submitting closePosition(${chosen.id})… tx=${tx1.hash}`);
      await tx1.wait();

      console.log(`\nWaiting for position #${chosen.id} to CLOSED...`);
      const res = await waitForPosition(chosen.id, "close", 2_000);
      if (res === "closed") {
        console.log(`✅ Position #${chosen.id} is CLOSED.`);
      } else {
        console.log(`⚠️  Position #${chosen.id} did not close in time.`);
      }
    }

    await rl.close();
  });
