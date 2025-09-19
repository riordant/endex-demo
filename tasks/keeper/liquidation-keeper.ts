// tasks/keeper/liquidation-keeper.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";
dotenv.config();

import { ethers as EthersLib } from "ethers";
import { AGGREGATOR_ABI, ENDEX_ABI, sleep } from "../utils";

/**
 * Long-running liquidation + settlement keeper.
 *
 * Optional params; all fall back to .env:
 *   ENDEX, AGGREGATOR, LOCAL_PRIVATE_KEY, FLAG_WAIT_MS (10000), SETTLE_WAIT_MS (10000)
 *
 * Usage:
 *   hardhat liquidation-keeper --network localhost
 *   hardhat liquidation-keeper --network localhost --flagWaitMs 8000 --settleWaitMs 12000
 */
task("liquidation-keeper", "Listen to price updates and run liq+settlement")
  .addOptionalParam("endex", "Endex address (env: ENDEX)")
  .addOptionalParam("aggregator", "MockV3Aggregator address (env: AGGREGATOR)")
  .addOptionalParam("privateKey", "Local private key (env: LOCAL_PRIVATE_KEY)")
  .addOptionalParam("flagWaitMs", "Wait after requestLiqChecks (ms)", "10000")
  .addOptionalParam("settleWaitMs", "Wait after finalizeLiqChecks (ms)", "10000")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    // ---- Resolve config (args → .env) ----
    const endexAddr      = args.endex      || process.env.ENDEX      || "";
    const aggregatorAddr = args.aggregator || process.env.AGGREGATOR || "";
    const flagWaitMs     = Number(args.flagWaitMs ?? process.env.FLAG_WAIT_MS ?? 10_000);
    const settleWaitMs   = Number(args.settleWaitMs ?? process.env.SETTLE_WAIT_MS ?? 10_000);
    const pk             = args.privateKey || process.env.LOCAL_PRIVATE_KEY || "";

    if (!endexAddr || !aggregatorAddr) {
      console.error(
        [
          "Missing required inputs:",
          `  ENDEX      : ${endexAddr      || "(missing)"}`,
          `  AGGREGATOR : ${aggregatorAddr || "(missing)"}`,
          "Provide via CLI args or .env.",
        ].join("\n")
      );
      return;
    }

    // ---- Providers & signer (use current --network provider) ----
    const provider = ethers.provider;
    const ws = new ethers.WebSocketProvider(process.env.LOCAL_WS);
    const sender = pk ? new EthersLib.Wallet(pk, provider) : (await ethers.getSigners())[0];
    
    // ---- Contracts ----
    const endex = new EthersLib.Contract(endexAddr, ENDEX_ABI, sender);
    // Use WS for event subscription; keep your sender (JSON-RPC) for txs
    const aggregator = new EthersLib.Contract(aggregatorAddr, AGGREGATOR_ABI, ws);

    console.log("=== Endex Liquidation/Settlement Keeper ===");
    console.log(`Network       : ${network.name}`);
    console.log(`Signer        : ${await sender.getAddress()}`);
    console.log(`Endex         : ${endexAddr}`);
    console.log(`MockV3Agg     : ${aggregatorAddr}`);
    console.log(`Flag wait     : ${flagWaitMs} ms`);
    console.log(`Settle wait   : ${settleWaitMs} ms`);
    console.log("-------------------------------------------");

    // ---- Helpers to find Open / AwaitingSettlement ids ----
    async function getOpenPositionIds(): Promise<bigint[]> {
      const nextId: bigint = await endex.nextPositionId();
      const ids: bigint[] = [];
      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id);
          const status: number = Number(p.status ?? p["status"]);
          if (status === 0) ids.push(id); // Open
        } catch {}
      }
      return ids;
    }

    async function getAwaitingSettlementIds(): Promise<bigint[]> {
      const nextId: bigint = await endex.nextPositionId();
      const ids: bigint[] = [];
      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id);
          const status: number = Number(p.status ?? p["status"]);
          if (status === 1) ids.push(id); // AwaitingSettlement
        } catch {}
      }
      return ids;
    }

    // ---- Prevent overlapping work ----
    let busy = false;
    async function cycle(reason: string) {
      if (busy) {
        console.log(`(busy) Skipping cycle triggered by: ${reason}`);
        return;
      }
      busy = true;

      try {
        console.log(`\n▶ Cycle triggered by: ${reason}`);

        // 1) requestLiqChecks → wait → finalizeLiqChecks
        const openIds = await getOpenPositionIds();
        console.log(`Open positions: ${openIds.length} ${openIds.length ? `[${openIds.join(",")}]` : ""}`);

        let shouldSettle = true;
        if (openIds.length > 0) {
          const tx1 = await endex.requestLiqChecks(openIds);
          console.log(`requestLiqChecks tx=${tx1.hash}`);
          await tx1.wait();

          console.log(`waiting FLAG_WAIT_MS=${flagWaitMs}ms for liq flag decrypt…`);
          await sleep(flagWaitMs);

          const tx2 = await endex.finalizeLiqChecks(openIds);
          console.log(`finalizeLiqChecks tx=${tx2.hash}`);
          await tx2.wait();
        } else {
          shouldSettle = false;
          console.log("No open positions → skipping liq request/finalize.");
        }

        // 2) wait → settle awaiting
        if (shouldSettle) {
          console.log(`waiting SETTLE_WAIT_MS=${settleWaitMs}ms for equity decrypt…`);
          await sleep(settleWaitMs);

          const awaiting = await getAwaitingSettlementIds();
          console.log(`AwaitingSettlement: ${awaiting.length} ${awaiting.length ? `[${awaiting.join(",")}]` : ""}`);

          if (awaiting.length > 0) {
            const tx3 = await endex.settlePositions(awaiting);
            console.log(`settlePositions tx=${tx3.hash}`);
            await tx3.wait();
            console.log("✓ Settlement complete.");
          } else {
            console.log("Nothing to settle.");
          }
        }
      } catch (e: any) {
        console.error("Cycle error:", e?.message || e);
      } finally {
        busy = false;
      }
    }

    async function shutdown() {
      console.log("\nShutting down…");
      aggregator.removeAllListeners();
      ws.removeAllListeners();
      try { await ws.destroy?.(); } catch {}
      process.exit(0);
    }
    
    // Subscribe to AnswerUpdated directly (no polling)
    aggregator.on("AnswerUpdated", async (...args : any) => {
      // Optional: args = [current, roundId, updatedAt, event]
      await cycle("AnswerUpdated");
    });

    // On shutdown, clean up and close the WS
    process.on("SIGINT", async () => { await shutdown(); });
    process.on("SIGTERM", async () => { await shutdown(); });

    // Keep the task alive until Ctrl+C
    await new Promise<void>((resolve) => {
      provider.pollingInterval = 5000;
      const shutdown = () => {
        console.log("\nShutting down…");
        provider.removeAllListeners();      // cleanup
        aggregator.removeAllListeners?.();  // (optional)
        resolve();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  });
