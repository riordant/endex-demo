import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";
dotenv.config();

import { ethers as EthersNS } from "ethers";
import { ENDEX_ABI, sleep } from "../utils";

/**
 * Position keeper: every N seconds, advance all positions by calling Endex.process(ids).
 * Active states: Requested(0), Pending(1), Open(2), AwaitingSettlement(3).
 *
 * Usage:
 *   hardhat position-keeper --network localhost
 *   hardhat position-keeper --network arb-sepolia --endex 0x... --pollMs 3000 --batch 64
 *
 * Env (fallbacks):
 *   ENDEX, LOCAL_PRIVATE_KEY_KEEPER, POLL_MS, BATCH
 */
task("position-keeper", "Polls positions and advances their state via Endex.process(ids)")
  .addOptionalParam("endex", "Endex address (env: ENDEX)")
  .addOptionalParam("pollMs", "Polling interval in ms (env: POLL_MS)", "10000")
  .addOptionalParam("batch", "Max ids per process() call (env: BATCH)", "80")
  .addOptionalParam("privateKey", "Keeper private key (env: LOCAL_PRIVATE_KEY_KEEPER)")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    // ---- Resolve config (CLI → .env) ----
    const endexAddr = args.endex || process.env.ENDEX || "";
    const pollMs    = Number(args.pollMs ?? process.env.POLL_MS ?? 10000);
    const batchSize = Number(args.batch  ?? process.env.BATCH  ?? 80);
    const pk        = args.privateKey || process.env.LOCAL_PRIVATE_KEY_KEEPER || "";

    if (!endexAddr) {
      console.error("Missing Endex address. Provide --endex or set ENDEX in .env.");
      return;
    }
    if (!Number.isFinite(pollMs) || pollMs < 1000) {
      throw new Error("pollMs must be >= 1000 ms");
    }
    if (!Number.isFinite(batchSize) || batchSize <= 0) {
      throw new Error("batch must be a positive integer");
    }

    // ---- Provider & signer (tx sender) ----
    const provider = ethers.provider;
    const signer   = pk ? new EthersNS.Wallet(pk, provider) : (await ethers.getSigners())[0];

    // ---- Contracts ----
    const endex = new EthersNS.Contract(endexAddr, ENDEX_ABI, signer);

    console.log("=== Endex Position Keeper ===");
    console.log(`Network : ${network.name}`);
    console.log(`Signer  : ${await signer.getAddress()}`);
    console.log(`Endex   : ${endexAddr}`);
    console.log(`pollMs  : ${pollMs}`);
    console.log(`batch   : ${batchSize}`);
    console.log("---------------------------------");

    // Status constants (EndexKeeper flow)
    const STATUS_REQUESTED = 0;
    const STATUS_PENDING   = 1;
    const STATUS_OPEN      = 2;
    const STATUS_AWAITING  = 3;
    const ACTIVE_SET = new Set([STATUS_REQUESTED, STATUS_PENDING, STATUS_OPEN, STATUS_AWAITING]);

    // util: chunk an array into size-N batches
    const chunk = <T,>(arr: T[], size: number) => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };

    // scan all positions and return the ids we should process
    async function gatherProcessIds(): Promise<bigint[]> {
      const ids: bigint[] = [];

      let nextId: bigint = 1n;
      try { nextId = await endex.nextPositionId(); } catch { return ids; }

      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id);

          // p.status is a uint8 enum
          const status: number = Number(p.status ?? p["status"]);
          if (!ACTIVE_SET.has(status)) continue;

          // If Requested, ensure not removed (validity.removed == false)
          if (status === STATUS_REQUESTED) {
            // nested struct is returned as an object by ethers
            const validity = p.validity ?? p["validity"];
            const removed  = Boolean(validity?.removed);
            if (removed) continue;
          }

          ids.push(id);
        } catch {
          // ignore missing ids / transient decode issues
        }
      }

      return ids;
    }

    let busy = false;

    async function cycle() {
      if (busy) return;
      busy = true;

      try {
        const ids = await gatherProcessIds();
        if (!ids.length) {
          // nothing to do this round
          return;
        }

        console.log(`Processing ${ids.length} id(s)…`);

        for (const group of chunk(ids, batchSize)) {
          try {
            const tx = await endex.process(group);
            console.log(`→ process(${group.join(",")})  tx=${tx.hash}`);
            await tx.wait();
            // minimal spacing so we don't spam mempool
            await sleep(200);
          } catch (e: any) {
            console.error("process() failed for batch:", group.map(String).join(","), "-", e?.message || e);
          }
        }
      } finally {
        busy = false;
      }
    }

    // simple poller loop (keeps cadence even if a cycle is slow)
    console.log("Keeper started. Ctrl+C to stop.");
    // Note: setInterval can overlap; guard with `busy` latch. :contentReference[oaicite:1]{index=1}
    const timer = setInterval(cycle, pollMs);

    // graceful shutdown
    const shutdown = () => {
      clearInterval(timer);
      console.log("\nShutting down…");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // run an immediate first pass
    await cycle();

    // keep the task alive
    await new Promise<void>(() => {});
  });
