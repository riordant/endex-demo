// tasks/global/dashboard.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

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
  coprocessor,
  decryptEuint256,
  unsealEint256,             // 👈 added
} from "../utils";
import {cofhejs_initializeWithHardhatSigner} from "cofhe-hardhat-plugin";

/**
 * Long-lived CLI dashboard for Endex/EndexView.
 *
 * Optional params; all fall back to .env:
 *   ENDEX (endex core), AGGREGATOR (local MockV3Aggregator),
 *   REFRESH_MS (default 5000), PRIVATE_KEY (env: LOCAL_PRIVATE_KEY)
 *
 * Usage:
 *   hardhat global-dashboard --network localhost
 *   hardhat global-dashboard --network localhost --refreshMs 3000
 */
task("global-dashboard", "Global metrics dashboard (funding, impact grid, positions)")
  .addOptionalParam("endex", "Endex core address (env: ENDEX)")
  .addOptionalParam("aggregator", "MockV3Aggregator address (env: AGGREGATOR)")
  .addOptionalParam("refreshMs", "Refresh interval (ms) (env: REFRESH_MS)", "5000")
  .addOptionalParam("privateKey", "Signer PK for funding/grid publishes (env: LOCAL_PRIVATE_KEY)")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    // ---- Resolve config (args → .env) ----
    const endexAddr = args.endex || process.env.ENDEX || "";
    const aggregatorAddr = args.aggregator || process.env.AGGREGATOR || "";
    const refreshMs = Number(args.refreshMs ?? process.env.REFRESH_MS ?? 5000);
    const pk = args.privateKey || process.env.LOCAL_PRIVATE_KEY || "";

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

    // ---- Provider & signer ----
    const provider = ethers.provider;
    const [signer] = await ethers.getSigners();
    await cofhejs_initializeWithHardhatSigner(hre, signer);

    // Write-capable endex (EndexView ABI) + read-only aggregator
    const endex = await ethers.getContractAt("Endex", endexAddr, signer);
    const aggregator = new ethers.Contract(aggregatorAddr, AGGREGATOR_ABI, provider);

    console.log(`\n=== Endex Metrics Dashboard — ${network.name} ===`);
    console.log(`Endex     : ${endexAddr}`);
    console.log(`Aggregator: ${aggregatorAddr}`);
    console.log(`Signer    : ${await signer.getAddress()}`);
    console.log(`Refresh   : ${refreshMs} ms`);
    console.log("----------------------------------------------");

    // ===== Cadence-driven publishers =====
    // Pull cadence values from contract (fall back if call fails)
    let FUNDING_PUBLISH_INTERVAL = 10_000; // ms fallback
    let IMPACT_PUBLISH_INTERVAL  = 10_000; // ms fallback

    try {
      const f = await endex.FUNDING_PUBLISH_INTERVAL();
      console.log("f: ", f);
      FUNDING_PUBLISH_INTERVAL = Number(f) * 1000;
    } catch {}
    try {
      const i = await endex.IMPACT_PUBLISH_INTERVAL();
      console.log("i: ", i);
      IMPACT_PUBLISH_INTERVAL = Number(i) * 1000;
    } catch {}

    // Background tickers that attempt request -> coprocessor -> finalize.
    // These are idempotent; contract cadence/pending guards will revert if not ready.
    async function tickFundingPublish() {
      try {
        const tx1 = await endex.requestFundingRatePublish();
        await tx1.wait();
        await coprocessor();
        const tx2 = await endex.finalizeFundingRatePublish();
        await tx2.wait();
      } catch {
        // cadence or pending — ignore
      }
    }

    const GRID_SIZES_USD: number[] = [100, 1_000, 10_000, 100_000];

    async function tickImpactGrid() {
      try {
        const tx1 = await endex.requestImpactGrid(GRID_SIZES_USD);
        await tx1.wait();
        await coprocessor();
        const tx2 = await endex.finalizeImpactGrid();
        await tx2.wait();
      } catch {
        // cadence or pending — ignore
      }
    }

    // Start cadence loops
    const fundingTimer = setInterval(tickFundingPublish, FUNDING_PUBLISH_INTERVAL);
    const gridTimer    = setInterval(tickImpactGrid,    IMPACT_PUBLISH_INTERVAL);

    // Run once immediately so the first draw has data if possible
    tickFundingPublish().catch(()=>{});
    tickImpactGrid().catch(()=>{});

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
      console.log("got market name");

      //let pendingCollateralUSDC6 = 0n;

      // Liquidity & collateral (new)
      console.log("get total liq");
      const totalLiquidityUSDC6   = BigInt(await endex.totalLiquidity());
      console.log("get pending col");
      const pendingCollateralUSDC6 = BigInt(await endex.pendingCollateral());
      console.log("get total col");
      const totalCollateralUSDC6   = BigInt(await endex.totalCollateral());
      console.log("got col and liq");


      let frEnc = await endex.fundingRatePerSecX18();
      let fr = await unsealEint256(frEnc);
      console.log("got fr");

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


        console.log(`funding: r: ${r}, ts: ${ts}, fr: ${fr}`);
      } catch {
          console.log("failed to get funding.");
      }
      console.log("got funding");

      // Impact grid (rounded bps)
      let grid: { sizes: number[]; longBps: number[]; shortBps: number[]; ts?: number } = { sizes: [], longBps: [], shortBps: [] };
      try {
        const ts = await endex.lastImpactPublishAt() as bigint;
        grid.ts = Number(ts);

        const sizes: number[] = [];
        const longBps: number[] = [];
        const shortBps: number[] = [];
        
      console.log("calling last grid sizes");
        for (let i = 0; i < 64; i++) {
          try {
            const s = await endex.lastGridSizesUsd(i);
            sizes.push(Number(s));
          } catch { break; }
        }
        for (let i = 0; i < sizes.length; i++) {
          try {
            longBps.push(Number(await endex.lastGridLongImpactBps(i)));
            shortBps.push(Number(await endex.lastGridShortImpactBps(i)));
          } catch { break; }
        }

        grid.sizes = sizes;
        grid.longBps = longBps;
        grid.shortBps = shortBps;
      } catch {}

      // Positions scan
      let nextId = 1n;
      try { nextId = await endex.nextPositionId(); } catch {}
      const totalPositions = Number(nextId > 0n ? nextId - 1n : 0n);

      let open = 0, awaiting = 0, liquidated = 0, closed = 0;
      let longs = 0, shorts = 0;

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
          // ignore holes
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
      console.log("Liquidity / Collateral");
      console.log(`  Liquidity (pool)   : $${fmtUSD6(totalLiquidityUSDC6)}`);
      console.log(`  Collateral (pending): $${fmtUSD6(pendingCollateralUSDC6)}`);
      console.log(`  Collateral (total)  : $${fmtUSD6(totalCollateralUSDC6)}`);

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
        const header = ["Idx", "Size USD", "Long bps", "Short bps"];
        console.log("  " + header.map((h) => h.padEnd(14)).join(""));
        const len = Math.max(grid.longBps.length, grid.shortBps.length, grid.sizes.length);
        for (let i = 0; i < len; i++) {
          console.log(
            "  " +
            String(i).padEnd(14) +
            String(grid.sizes[i] ?? "").padEnd(14) +
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
    const drawTimer = setInterval(async () => {
      try { await collectAndDraw(); }
      catch (e: any) {
        clearScreen();
        console.error("Metrics error:", e?.message || e);
      }
    }, refreshMs);

    // Keep alive until Ctrl+C
    const shutdown = () => {
      clearInterval(drawTimer);
      clearInterval(fundingTimer);
      clearInterval(gridTimer);
      console.log("\nShutting down…");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise<void>(() => {}); // never resolve
  });
