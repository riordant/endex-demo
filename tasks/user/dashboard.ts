// tasks/user/dashboard.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as readline from "node:readline";
import { cofhejs_initializeWithHardhatSigner } from "cofhe-hardhat-plugin";
import { cofhejs, FheTypes } from "cofhejs/node";
import {
  getDeployment,
  clearScreen,
  AGGREGATOR_ABI,
  coprocessor,
  sleep,
} from "../utils";

import { drawPositionsTable } from "./ui/positionsTable";
import { drawEquityTable } from "./ui/equityTable";

task("user-dashboard", "GMX-style user dashboard with batched owner-equity refresh + equity breakdown")
  .addOptionalParam("endex", "Override Endex address")
  .addOptionalParam("aggregator", "Override AggregatorV3 address")
  .addOptionalParam("refreshMs", "Screen refresh interval (ms), default 10000")
  .addOptionalParam("equityRefreshMs", "How often to trigger ownerEquity batch (ms), default 7000")
  .addOptionalParam("equityCooldownMs", "Min gap between ownerEquity batches (ms), default 5000")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    console.log("loading..");

    // ---- Signer + CoFHE init ----
    const [signer] = await ethers.getSigners();
    await cofhejs_initializeWithHardhatSigner(hre, signer);

    // ---- Resolve addresses ----
    const endexAddr = args.endex || getDeployment?.(network.name, "Endex");
    if (!endexAddr) throw new Error("Missing Endex address. Use --endex or deploy first.");
    const endex = await ethers.getContractAt("Endex", endexAddr, signer);

    const aggAddr = args.aggregator || getDeployment?.(network.name, "PriceFeed");
    if (!aggAddr) throw new Error("Missing Aggregator address. Use --aggregator or deploy first.");
    const aggregator = new ethers.Contract(aggAddr, AGGREGATOR_ABI, ethers.provider);

    // ---- Config ----
    const refreshMs        = Number(args.refreshMs ?? 10_000);
    const equityRefreshMs  = Number(args.equityRefreshMs ?? 7_000);
    const equityCooldownMs = Number(args.equityCooldownMs ?? 5_000);

    // ---- Helpers ----
    const toNumE8 = (x: bigint) => Number(x) / 1e8;

    // ---- State ----
    let knownIds: bigint[] = [];
    let lastBatchAt = 0;
    let batching = false;

    async function listOwnedIds(): Promise<bigint[]> {
      const out: bigint[] = [];
      let nextId: bigint = 1n;
      try { nextId = await endex.nextPositionId(); } catch {}
      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id);
          if (p.owner?.toLowerCase() === signer.address.toLowerCase()) out.push(id);
        } catch {}
      }
      return out;
    }

    // -------- BACKGROUND: batched ownerEquity(positionId, oraclePriceE8) --------
    async function refreshEquityBatch() {
      if (batching) return;
      const now = Date.now();
      if (now - lastBatchAt < equityCooldownMs) return;

      batching = true;
      try {
        knownIds = await listOwnedIds();
        if (!knownIds.length) return;

        // fetch oracle price once
        let priceE8 = 0n;
        try {
          const rd = await aggregator.latestRoundData();
          priceE8 = BigInt(rd[1]);
        } catch {}

        // Stage equity for all positions in parallel (ignore failures for non-open)
        await Promise.allSettled(
          knownIds.map(async (id) => {
            try {
              const tx = await (endex as any).ownerEquity(id, priceE8);
              await tx.wait();
            } catch { /* ignore */ }
          })
        );

        // finalize all at once
        await coprocessor();
        lastBatchAt = Date.now();
      } catch (e: any) {
        console.error("equity batch error:", e?.message || e);
      } finally {
        batching = false;
      }
    }

    await refreshEquityBatch();
    const refreshTimer = setInterval(refreshEquityBatch, equityRefreshMs);

    // -------- FOREGROUND: draw UI (non-blocking) --------
    async function draw() {
      clearScreen();
      const now = new Date();
      console.log(`Endex — User Dashboard (${network.name})  ${now.toLocaleString()}`);
      console.log("".padEnd(120, "─"));
      console.log(`User  : ${signer.address}`);
      console.log(`Endex : ${endexAddr}`);
      console.log(`Oracle: ${aggAddr}\n`);

      let market = "ETH/USD";
      try { market = await (endex as any).marketName(); } catch {}

      // public MM bps
      let mmBps = 0;
      try { mmBps = Number(await (endex as any).MAINT_MARGIN_BPS()); } catch {}

      // ensure we have ids
      if (!knownIds.length) knownIds = await listOwnedIds();
      if (!knownIds.length) {
        console.log("No positions for this user.");
        console.log(`Next refresh in ${(refreshMs/1000)|0}s — Ctrl+C to exit`);
        return;
      }

      // mark price
      let markPx = NaN;
      try { const rd = await aggregator.latestRoundData(); markPx = toNumE8(BigInt(rd[1])); } catch {}

      //const pendingEquity = await (endex as any).pendingEquity(owner, id);

      // ---- Draw Positions (top table) ----
      await drawPositionsTable({
        ethers,
        endex,
        signer,
        knownIds,
        market,
        markPx,
        mmBps,
        // equity source: pendingEquity mapping (unsealed in the table function)
        getPendingEquity: async (owner: string, id: bigint) => {
          // returns raw struct from contract getter
          return await (endex as any).pendingEquity(owner, id);
        },
        cofhejs,
        FheTypes,
      });

      console.log("");

      // ---- Draw Equity breakdown (second table) ----
      await drawEquityTable({
        ethers,
        endex,
        signer,
        knownIds,
        market,
        getPendingEquity: async (owner: string, id: bigint) => {
          return await (endex as any).pendingEquity(owner, id);
        },
        cofhejs,
        FheTypes,
      });

      const eta = Math.max(0, equityCooldownMs - (Date.now() - lastBatchAt));
      console.log(
        `\nNext screen refresh in ${(refreshMs/1000)|0}s — Ctrl+C to exit  |  Equity batch ${batching ? "(running…)" : `ready in ~${eta}ms`}`
      );
    }

    // draw loop
    await draw();
    const drawTimer = setInterval(draw, refreshMs);

    // keep alive & graceful exit
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str: any, key: any) => {
      if (key.sequence === "\u0003") {
        clearInterval(drawTimer);
        clearInterval(refreshTimer);
        try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
        process.exit(0);
      }
    });

    await new Promise<void>((resolve) => {
      const shutdown = () => {
        clearInterval(drawTimer);
        clearInterval(refreshTimer);
        try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
        resolve();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  });
