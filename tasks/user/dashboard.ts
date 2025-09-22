// tasks/user/dashboard.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as readline from "node:readline";
import { cofhejs_initializeWithHardhatSigner } from "cofhe-hardhat-plugin";
import { cofhejs, FheTypes } from "cofhejs/node";
import {
  getDeployment,
  clearScreen,
  fmtUSD6,
  parseStatus,
  parseCloseCause,
  AGGREGATOR_ABI,
  coprocessor,
  fmtPnl,
} from "../utils";

task("user-dashboard", "GMX-style user dashboard with batched owner-equity refresh")
  .addOptionalParam("endex", "Override Endex address")
  .addOptionalParam("aggregator", "Override AggregatorV3 address")
  .addOptionalParam("refreshMs", "Screen refresh interval (ms), default 10000")
  .addOptionalParam("equityRefreshMs", "How often to trigger ownerEquity batch (ms), default 7000")
  .addOptionalParam("equityCooldownMs", "Min gap between ownerEquity batches (ms), default 5000")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    console.log("loading..");
    const { ethers, network } = hre;

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
    const usd = (x: number, d = 2) =>
      x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    const div1e18 = (x: bigint) => BigInt(x / BigInt(1e18));
    const col = (s: string, w: number) => {
      s = String(s);
      return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
    };

    // ---- State ----
    let knownIds: bigint[] = [];
    let lastBatchAt = 0;
    let batching = false;

    // Discover user-owned positions
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

    // -------- BACKGROUND: batched equity refresh --------
    async function refreshEquityBatch() {
      if (batching) return;
      const now = Date.now();
      if (now - lastBatchAt < equityCooldownMs) return;

      batching = true;
      try {
        knownIds = await listOwnedIds();
        if (!knownIds.length) return;

        // Stage equity for all positions in parallel
        const receipts = await Promise.allSettled(
          knownIds.map(async (id) => {
              try {
                const tx = await (endex as any).ownerEquity(id);
                return tx.wait();
              } catch {
                  // igmore failures for closed positions
              }
          })
        );

        // Single coprocessor finalize for all staged equities
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

      // maintenance margin bps (public)
      let mmBps = 0;
      try { mmBps = Number(await (endex as any).MAINT_MARGIN_BPS()); } catch {}
      const m = mmBps / 10_000;

      if (!knownIds.length) knownIds = await listOwnedIds();
      if (!knownIds.length) {
        console.log("No positions for this user.");
        console.log(`Next refresh in ${(refreshMs/1000)|0}s — Ctrl+C to exit`);
        return;
      }

      // Current mark price (oracle)
      let markPx = NaN;
      try { const rd = await aggregator.latestRoundData(); markPx = toNumE8(BigInt(rd[1])); } catch {}

      let netValue = BigInt(0);

      // Header
      console.log(
        col("POSITION",      28) +
        col("SIZE",          16) +
        col("NET VALUE",     16) +
        col("COLLATERAL",    16) +
        col("PNL",           16) +
        col("ENTRY PRICE",   16) +
        col("MARK PRICE",    16) +
        col("LIQ. PRICE",    16) +
        col("SETTLED PRICE", 16) +
        col("STATUS",     28)
      );

      for (const id of knownIds) {
        let p: any;
        try { p = await endex.getPosition(id); } catch { continue; }

        const isLong = Boolean(p.isLong);
        const collateralUSDC6 = BigInt(p.collateral);
        const collateral = Number(collateralUSDC6) / 1e6;
        const entry = toNumE8(BigInt(p.entryPrice));

        // SIZE (owner-decrypted)
        let sizeUSDC6 = 0n;
        let sizeStr = "—";
        try {
          const sizeDec = await cofhejs.unseal(p.size, FheTypes.Uint256);
          if (sizeDec.success) {
            sizeUSDC6 = BigInt(sizeDec.data);
            sizeStr = "$" + fmtUSD6(sizeUSDC6);
          }
        } catch {}

        // NET VALUE (sealed by ownerEquity batch → unseal pendingEquityX18)
        let netValueStr = "—";
        try {
          const eqDec = await cofhejs.unseal(p.pendingEquityX18, FheTypes.Uint256);
          if (eqDec.success) {
            netValue = div1e18(BigInt(eqDec.data));
            netValueStr = "$" + fmtUSD6(netValue);
            //console.log("raw result equity:", BigInt(eqDec.data));
            //console.log("div result equity:", netValue);
            //console.log("format result equity:", netValueStr);
          } else {
              console.log("unsucessful decrypt")
          }
        } catch {}

        let pnlStr = fmtPnl(netValue - collateralUSDC6);

        // leverage display
        let levStr = "—";
        if (sizeUSDC6 > 0n && collateral > 0) {
          const lev = (Number(sizeUSDC6) / 1e6) / collateral;
          levStr = (lev >= 100 ? lev.toFixed(0) : lev.toFixed(2)) + "x";
        }

        // liq price (approx; oracle mark model; funding paid on close ⇒ no drift mid-life)
        let liqStr = "—";
        if (sizeUSDC6 > 0n && entry > 0 && mmBps > 0) {
          const S = Number(sizeUSDC6) / 1e6;
          const C = collateral;
          const F = 0;
          if (isLong) {
            const term = 1 - (C - F - m * S) / S;
            liqStr = "$" + usd(entry * term, 2);
          } else {
            const term = 1 + (C - F - m * S) / S;
            liqStr = "$" + usd(entry * term, 2);
          }
        }

        // liq price (approx; oracle mark model; funding paid on close ⇒ no drift mid-life)
        let settledPx = 0;
        if (p.settlementPrice > 0) {
            settledPx = toNumE8(BigInt(p.settlementPrice));
        }

        const status = parseStatus(p.status);
        const cause  = (status === "Closed" || status === "Liquidated") ? parseCloseCause(p.cause) : "";
        const statusCell = status + (cause ? " / " + cause : "");

        // POSITION (single line)
        const positionCell = `${market} • ${levStr} ${isLong ? "Long" : "Short"}`;

        console.log(
          col(positionCell, 28) +
          col(sizeStr,      16) +
          col(netValueStr,  16) +
          col("$" + usd(collateral, 2), 16) +
          col(pnlStr,  16) +
          col("$" + usd(entry, 2),     16) +
          col(Number.isFinite(markPx) ? ("$" + usd(markPx, 2)) : "—", 16) +
          col(liqStr,       16) +
          col(settledPx > 0 ? ("$" + usd(settledPx, 2)) : "—", 16) +
          col(statusCell,   28)
        );
      }

      const eta = Math.max(0, equityCooldownMs - (Date.now() - lastBatchAt));
      console.log(`\nNext screen refresh in ${(refreshMs/1000)|0}s — Ctrl+C to exit  |  Equity batch ${batching ? "(running…)" : `ready in ~${eta}ms`}`);
    }

    // Draw loop
    await draw();
    const drawTimer = setInterval(draw, refreshMs);

    // Keep alive & graceful exit
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
