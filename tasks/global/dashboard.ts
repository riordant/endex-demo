// tasks/global/dashboard.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

// Import all helpers/ABIs from your local utils (per your instruction)
import {
  parseStatus,
  parseCloseCause,
  bpPerHourFromX18,
  bpPerDayFromX18,
  fmtPriceE8,
  clearScreen,
  fmt,
  fmtUSD6,
  ENDEX_ABI,
  AGGREGATOR_ABI,
  decryptBool,
} from "../utils";

/**
 * Long-lived CLI dashboard for Endex/EndexView.
 *
 * Optional params; all fall back to .env:
 *   ENDEX (endex core), AGGREGATOR (local MockV3Aggregator),
 *   REFRESH_MS (default 5000)
 *
 * Usage:
 *   hardhat metrics-global --network localhost
 *   hardhat metrics-global --network localhost --refreshMs 3000 --priceDecimals 8
 */
task("global-dashboard", "Global metrics dashboard (funding, impact grid, positions)")
  .addOptionalParam("endex", "Endex core address (env: ENDEX)")
  .addOptionalParam("aggregator", "MockV3Aggregator address (env: AGGREGATOR)")
  .addOptionalParam("refreshMs", "Refresh interval (ms) (env: REFRESH_MS)", "5000")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers: hhEthers, network } = hre;

    // ---- Resolve config (args → .env) ----
    const endexAddr = args.endex || process.env.ENDEX || "";
    const aggregatorAddr = args.aggregator || process.env.AGGREGATOR || "";
    const refreshMs = Number(args.refreshMs ?? process.env.REFRESH_MS ?? 5000);

    if (!endexAddr || !aggregatorAddr) {
      console.error(
        [
          "Missing required addresses:",
          `  ENDEX      : ${endexAddr || "(missing)"}`,
          `  AGGREGATOR : ${aggregatorAddr || "(missing)"}`,
          "Provide via CLI args or .env.",
        ].join("\n")
      );
      return;
    }

    // ---- Bind provider + contracts (read-only) ----
    const provider = hhEthers.provider; // current --network provider
    const endex = new ethers.Contract(endexAddr, ENDEX_ABI, provider);
    const aggregator = new ethers.Contract(aggregatorAddr, AGGREGATOR_ABI, provider);

    console.log(`\n=== Endex Metrics Dashboard — ${network.name} ===`);
    console.log(`Endex     : ${endexAddr}`);
    console.log(`Aggregator: ${aggregatorAddr}`);
    console.log(`Refresh   : ${refreshMs} ms`);
    console.log("----------------------------------------------");

    // ---- Collect + render ----
    type Position = {
      id: bigint;
      isLong: boolean;
      status: string;
      collateral: bigint;
      entryPriceE8: bigint;
      settlementPriceE8: bigint;
      closeCause: string;
    };

    async function collectAndDraw() {
      // Global info
      let marketName = "ETH/USD";
      let maxLev = "5x";
      try { marketName = await endex.marketName(); } catch {}

      // Funding (rounded, published)
      let funding: { perSecX18?: bigint; bpHr?: number; bpDay?: number; ts?: number } = {};
      try {
        const [r, ts] = await Promise.all([
          endex.lastFundingRatePerSecRoundedX18() as Promise<bigint>,
          endex.lastFundingPublishAt() as Promise<bigint>,
        ]);
        funding.perSecX18 = r;
        funding.bpHr = bpPerHourFromX18(r);
        funding.bpDay = bpPerDayFromX18(r);
        funding.ts = Number(ts);
      } catch {}

      // Impact grid (rounded bps)
      let grid: { sizes: number[]; longBps: number[]; shortBps: number[]; ts?: number } = { sizes: [], longBps: [], shortBps: [] };
      try {
        const ts = await endex.lastImpactPublishAt() as bigint;
        grid.ts = Number(ts);

        const sizes: number[] = [];        // uncomment when sizes are exposed
        const longBps: number[] = [];
        const shortBps: number[] = [];
        for (let i = 0; i < 64; i++) {
          try {
            // sizes.push(Number(await endex.lastGridSizesUsd(i)));
            longBps.push(Number(await endex.lastGridLongImpactBps(i)));
            shortBps.push(Number(await endex.lastGridShortImpactBps(i)));
          } catch { break; }
        }
        grid.sizes = sizes.filter((v) => v > 0);
        grid.longBps = grid.sizes.length ? longBps.slice(0, grid.sizes.length) : longBps;
        grid.shortBps = grid.sizes.length ? shortBps.slice(0, grid.sizes.length) : shortBps;
      } catch {}

      // Positions scan
      let nextId = 1n;
      try { nextId = await endex.nextPositionId(); } catch {}
      const totalPositions = Number(nextId > 0n ? nextId - 1n : 0n);

      let open = 0, awaiting = 0, liquidated = 0, closed = 0;
      let longs = 0, shorts = 0;
      let totalCollateralUSDC6 = 0n;
      const recentClosed: Array<{ id: bigint; cause: string; settleE8: bigint }> = [];

      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id) as any;
          const pos: Position = {
            id,
            isLong: await decryptBool(p[2]),
            status: parseStatus(p[9]),
            collateral: BigInt(p[4]),
            entryPriceE8: BigInt(p[5]),
            settlementPriceE8: BigInt(p[8]),
            closeCause: parseCloseCause(p[10]),
          };

          if (pos.isLong) longs++; else shorts++;
          totalCollateralUSDC6 += pos.collateral;

          switch (pos.status) {
            case "Open": open++; break;
            case "Awaiting Settlement": awaiting++; break;
            case "Liquidated": liquidated++; break;
            case "Closed":
              closed++;
              recentClosed.push({ id: pos.id, cause: pos.closeCause, settleE8: pos.settlementPriceE8 });
              if (recentClosed.length > 10) recentClosed.shift();
              break;
          }
        } catch {
          // ignore missing ids
        }
      }

      // Oracle price (optional)
      let oracleStr = "";
      try {
        const [ , answer ] = await aggregator.latestRoundData();
        oracleStr = fmtPriceE8(answer);
      } catch {}

      // Render
      clearScreen();

      const now = new Date();
      console.log(`Endex Metrics — ${now.toLocaleString()}`);
      console.log("".padEnd(80, "─"));

      console.log(`Market        : ${marketName || "(unknown)"}`);
      console.log(`Max Leverage  : ${maxLev || "(unknown)"}`);
      if (oracleStr) console.log(`Oracle Price  : $${oracleStr}`);

      console.log("");
      console.log("Funding (rounded, published on-chain)");
      if (funding.perSecX18 !== undefined) {
        const dir = (funding.perSecX18 >= 0n) ? "Longs → Shorts" : "Shorts → Longs";
        console.log(`  Direction   : ${dir}`);
        console.log(`  Rate (bp/hr): ${fmt(Math.abs(funding.bpHr || 0), 1)}`);
        console.log(`  Rate (bp/d) : ${fmt(Math.abs(funding.bpDay || 0), 1)}`);
        if (funding.ts) {
          const t = new Date(funding.ts * 1000);
          console.log(`  Published@  : ${t.toLocaleString()}`);
        }
      } else {
        console.log("  (no published funding yet)");
      }

      console.log("");
      console.log("Impact Grid (signed bps; +penalty / −rebate)");
      if (grid.longBps.length || grid.shortBps.length) {
        const header = ["Idx", "Long bps", "Short bps"];
        console.log("  " + header.map((h) => h.padEnd(14)).join(""));
        const len = Math.max(grid.longBps.length, grid.shortBps.length);
        for (let i = 0; i < len; i++) {
          console.log(
            "  " +
            String(i).padEnd(14) +
            String(grid.longBps[i] ?? "").padEnd(14) +
            String(grid.shortBps[i] ?? "").padEnd(14)
          );
        }
        if (grid.ts) {
          const t = new Date(grid.ts * 1000);
          console.log(`  Published@  : ${t.toLocaleString()}`);
        }
      } else {
        console.log("  (no published grid yet)");
      }

      console.log("");
      console.log("Positions");
      console.log(`  Total             : ${totalPositions}`);
      console.log(`  Open              : ${open}   (awaiting: ${awaiting}, liquidated: ${liquidated}, closed: ${closed})`);
      console.log(`  Long vs Short     : ${longs} long / ${shorts} short`);
      console.log(`  Total Collateral  : $${fmtUSD6(totalCollateralUSDC6)}`);

      console.log("");
      console.log("Recent Closed (last 10)");
      if (recentClosed.length) {
        console.log("  " + ["ID", "Cause", "Settle Price"].map((h) => h.padEnd(18)).join(""));
        for (const rc of recentClosed) {
          console.log(
            "  " +
            String(rc.id).padEnd(18) +
            String(rc.cause).padEnd(18) +
            ("$" + fmtPriceE8(rc.settleE8)).padEnd(18)
          );
        }
      } else {
        console.log("  (none yet)");
      }

      console.log("");
      console.log(`Next refresh in ${(refreshMs / 1000) | 0}s — Ctrl+C to exit`);
    }

    // First draw then interval
    await collectAndDraw();
    const timer = setInterval(async () => {
      try { await collectAndDraw(); }
      catch (e: any) {
        clearScreen();
        console.error("Metrics error:", e?.message || e);
      }
    }, refreshMs);

    // Keep the task alive until Ctrl+C
    process.on("SIGINT", () => { clearInterval(timer); console.log("\nShutting down…"); process.exit(0); });
    process.on("SIGTERM", () => { clearInterval(timer); console.log("\nShutting down…"); process.exit(0); });
    await new Promise<void>(() => {}); // never resolve
  });
