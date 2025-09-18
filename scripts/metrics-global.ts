/* scripts/metrics-global.ts
   One-file, long-lived CLI dashboard for Endex/EndexView.
   - Updates every 5s
   - Reads rounded funding + impact grid from EndexView
   - Scans positions from Endex to summarize counts/totals
   - Shows recent closed positions (cause + settlement price)

   ENV / CLI:
     LOCAL_RPC             (default http://127.0.0.1:8545)
     ENDEX                 (required)    -- address of Endex (core)
     PRICE_DECIMALS        (default 8)   -- Chainlink price decimals when showing settlement price
     REFRESH_MS            (default 5000)

   Usage:
     ts-node scripts/metrics-global.ts \
       --endex 0x... \
       --localRpc http://127.0.0.1:8545 \
       --refreshMs 5000
*/

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

type Opts = {
  localRpc: string;
  endex: string;
  refreshMs: number;
  priceDecimals: number;
};

function parseStatus(status : BigInt) {
    switch(status) {
    case 0n:
        return "Open"
    case 1n:
        return "Awaiting Settlement"
    case 2n:
        return "Liquidated"
    case 3n:
        return "Closed"
    default:
        throw new Error("Unknown Status")
    }
}


function parseCloseCause(status : BigInt) {
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

function parseArgs(): Opts {
  const arg = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i], v = process.argv[i + 1];
    if (k?.startsWith("--") && v) arg.set(k.slice(2), v);
  }
  const localRpc = arg.get("localRpc") || process.env.LOCAL_RPC || "http://127.0.0.1:8545";
  const endex = arg.get("endex") || process.env.ENDEX || "";
  const refreshMs = Number(arg.get("refreshMs") || process.env.REFRESH_MS || 5_000);
  const priceDecimals = Number(arg.get("PRICE_DECIMALS") || process.env.PRICE_DECIMALS || 8);

  if (!endex) {
    console.error("Missing --endex / ENDEX");
    process.exit(1);
  }

  return { localRpc, endex, refreshMs, priceDecimals };
}

// Minimal ABIs — prefer your compiled artifacts if available.
const endexAbi = loadAbi("contracts/Endex.sol/Endex.json", [
  // Fallback fragments if artifact path differs:

  "function nextPositionId() view returns (uint256)",
  // Position struct (index-based fallback): adapt field order if yours differs
  "function getPosition(uint256 id) view returns (tuple(bool isLong, uint8 status, uint256 collateral, uint256 entryPriceE8, uint256 settlementPriceE8, uint8 closeCause))",

  // If you have a public helper for price E8, expose & include it here; otherwise we skip printing it.
  "function getPriceE8() view returns (uint256)",

  // Rounded funding per-second (X18), updated every 10 minutes by your publisher.
  "function lastFundingRatePerSecRoundedX18() view returns (int256)",
  "function lastFundingPublishAt() view returns (uint256)",

  // Coarse impact grid
  "function lastImpactPublishAt() view returns (uint256)",
  "function lastGridSizesUsd(uint256) view returns (uint32)",
  "function lastGridLongImpactBps(uint256) view returns (int32)",
  "function lastGridShortImpactBps(uint256) view returns (int32)",

  // Optional helpers:
  "function marketName() view returns (string)",
  "function maxLeverageX() view returns (uint256)",
]);

function loadAbi(relativePath: string, fallback: string[]) {
  try {
    const full = path.join(process.cwd(), "artifacts", relativePath);
    if (fs.existsSync(full)) {
      const json = JSON.parse(fs.readFileSync(full, "utf8"));
      return json.abi;
    }
  } catch {}
  return fallback;
}

type Position = {
  id: bigint;
  isLong: boolean;
  status: string;           // see parseStatus
  collateral: bigint;       // USDC 6d
  entryPriceE8: bigint;     // price 8d
  settlementPriceE8: bigint;// price 8d (if closed)
  closeCause: string;       // see parseCloseCause
};

function bpPerHourFromX18(ratePerSecX18: bigint): number {
  // bp/hr = rate * 3600 * 1e4
  const r = Number(ratePerSecX18) / 1e18;
  return r * 3600 * 1e4;
}
function bpPerDayFromX18(ratePerSecX18: bigint): number {
  // bp/day = rate * 86400 * 1e4
  const r = Number(ratePerSecX18) / 1e18;
  return r * 86400 * 1e4;
}

function fmtUSD6(usdc6: bigint): string {
  return (Number(usdc6) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPriceE8(p: bigint, priceDecimals: number): string {
  const scale = 10 ** priceDecimals;
  return (Number(p) / scale).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmt(num: number, frac = 2): string {
  return num.toLocaleString(undefined, { minimumFractionDigits: frac, maximumFractionDigits: frac });
}

function clearScreen() {
  // ANSI: ESC[2J clear screen, ESC[H cursor home
  process.stdout.write("\x1b[2J\x1b[H");
}

async function main() {
  const opts = parseArgs();
  const provider = new ethers.JsonRpcProvider(opts.localRpc);

  const endex = new ethers.Contract(opts.endex, endexAbi, provider);

  let lastDraw = 0;

  async function collect() {
    // ---- Global “static-ish” info
    let marketName = "ETH/USD";
    let maxLev = "5x";
    try { marketName = await (endex.marketName()); } catch {}

    // ---- Funding (rounded published)
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

    // ---- Impact grid (rounded bps)
    let grid: { sizes: number[]; longBps: number[]; shortBps: number[]; ts?: number } = { sizes: [], longBps: [], shortBps: [] };
    try {
      const ts = await endex.lastImpactPublishAt() as bigint;
      grid.ts = Number(ts);
      // pull sequentially until it reverts (cheapest MVP) — or keep a mirrored count on-chain
      const sizes: number[] = [];
      const longBps: number[] = [];
      const shortBps: number[] = [];
      for (let i = 0; i < 64; i++) {
        try {
          //sizes.push(Number(await endex.lastGridSizesUsd(i)));
          longBps.push(Number(await endex.lastGridLongImpactBps(i)));
          shortBps.push(Number(await endex.lastGridShortImpactBps(i)));
        } catch {
          break;
        }
      }
      // filter trailing zeros if any
      grid.sizes = sizes.filter((v) => v > 0);
      grid.longBps = longBps.slice(0, grid.sizes.length);
      grid.shortBps = shortBps.slice(0, grid.sizes.length);
    } catch {}

    // ---- Positions scan (MVP)
    let nextId = 1n;
    try { nextId = await endex.nextPositionId(); } catch {}
    const totalPositions = Number(nextId > 0n ? nextId - 1n : 0n);

    let open = 0, awaiting = 0, liquidated = 0, closed = 0;
    let longs = 0, shorts = 0;
    let totalCollateralUSDC6 = 0n;

    // capture a few recent closed for the table
    const recentClosed: Array<{ id: bigint; cause: number; settleE8: bigint }> = [];

    for (let id = 1n; id < nextId; id++) {
      console.log("in to loop");
      try {
        const p = await endex.getPosition(id) as any;
        console.log(p);
        console.log(p[0]);
        const pos: Position = {
          id,
          isLong: Boolean(p[2]),
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
            // keep up to last 10 closed
            recentClosed.push({ id: pos.id, cause: pos.closeCause, settleE8: pos.settlementPriceE8 });
            if (recentClosed.length > 10) recentClosed.shift();
            break;
        }
      } catch {
        console.log("failed.");
        // ignore gaps
      }
    }

    // ---- Try to read your on-chain oracle helper (optional)
    let oracle = "";
    try {
      const priceE8 = await endex.getPriceE8();
      oracle = fmtPriceE8(priceE8, opts.priceDecimals);
    } catch {}

    // ---- Build the frame
    const now = new Date();
    clearScreen();

    console.log(`Endex Metrics — ${now.toLocaleString()}`);
    console.log("".padEnd(80, "─"));

    console.log(`Market        : ${marketName || "(unknown)"}`);
    console.log(`Max Leverage  : ${maxLev || "(unknown)"}`);
    if (oracle) console.log(`Oracle Price  : $${oracle}`);

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
    if (grid.sizes.length) {
      const header = ["Size (USD)", "Long bps", "Short bps"];
      console.log("  " + header.map((h) => h.padEnd(14)).join(""));
      for (let i = 0; i < grid.sizes.length; i++) {
        console.log(
          "  " +
          String(grid.sizes[i]).padEnd(14) +
          String(grid.longBps[i]).padEnd(14) +
          String(grid.shortBps[i]).padEnd(14)
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
          ("$" + fmtPriceE8(rc.settleE8, opts.priceDecimals)).padEnd(18)
        );
      }
    } else {
      console.log("  (none yet)");
    }

    // footer
    console.log("");
    console.log(`Next refresh in ${(opts.refreshMs / 1000)|0}s — Ctrl+C to exit`);

    lastDraw = Date.now();
  }

  await collect();

  setInterval(async () => {
    try { await collect(); }
    catch (e: any) {
      clearScreen();
      console.error("Metrics error:", e?.message || e);
    }
  }, opts.refreshMs);

  // Keep process alive
  process.stdin.resume();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
