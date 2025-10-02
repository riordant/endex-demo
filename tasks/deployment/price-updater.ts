// tasks/deployment/price-updater.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

import { AGGREGATOR_ABI, scaleToDecimals } from "../utils";

/**
 * Mirrors a remote Chainlink AggregatorV3 proxy to a local MockV3Aggregator.
 *
 * Optional params; all fall back to .env:
 *   REMOTE_RPC, REMOTE_FEED, AGGREGATOR, LOCAL_PRIVATE_KEY, POLL_MS
 *
 * Usage examples:
 *   hardhat price-updater --network localhost
 *   hardhat price-updater --remoteFeed 0x... --aggregator 0x... --remoteRpc https://... --pollMs 2000
 */
task("price-updater", "Mirror a remote Chainlink feed → local MockV3Aggregator")
  .addOptionalParam("remoteFeed", "Remote Chainlink Aggregator proxy address (REMOTE_FEED)")
  .addOptionalParam("aggregator", "Local MockV3Aggregator address (AGGREGATOR)")
  .addOptionalParam("remoteRpc", "Remote RPC URL (REMOTE_RPC)")
  .addOptionalParam("pollMs", "Polling interval in ms (POLL_MS)", "3000")
  .addOptionalParam("privateKey", "Local private key for txs (LOCAL_PRIVATE_KEY)")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers: hhEthers, network } = hre;

    // ----- Resolve config: prefer args, then .env -----
    const remoteFeed = args.remoteFeed || process.env.REMOTE_FEED || "";
    const remoteRpc  = args.remoteRpc  || process.env.REMOTE_RPC  || "";
    const aggregator = args.aggregator || process.env.AGGREGATOR  || "";
    const pollMs     = Number(args.pollMs ?? process.env.POLL_MS ?? 3000);
    const pk         = args.privateKey || process.env.LOCAL_PRIVATE_KEY || "";

    // Validate requireds
    if (!remoteFeed || !remoteRpc || !aggregator) {
      console.error(
        [
          "Missing required inputs:",
          `  remoteFeed / REMOTE_FEED : ${remoteFeed || "(missing)"}`,
          `  remoteRpc  / REMOTE_RPC  : ${remoteRpc  || "(missing)"}`,
          `  aggregator / AGGREGATOR  : ${aggregator || "(missing)"}`,
          "",
          "Provide via CLI args or .env. Example .env:",
          "  REMOTE_RPC=... ",
          "  REMOTE_FEED=0x... ",
          "  AGGREGATOR=0x... ",
          "  LOCAL_PRIVATE_KEY=0x... (optional) ",
          "  POLL_MS=3000",
        ].join("\n")
      );
      return;
    }

    // ----- Providers & signer -----
    const remoteProvider = new ethers.JsonRpcProvider(remoteRpc);
    const localProvider  = hhEthers.provider; // current --network provider (localhost)
    let sender;
    if (pk) {
      sender = new ethers.Wallet(pk, localProvider);
    } else {
      const [s] = await hhEthers.getSigners();
      sender = s;
    }

    // ----- Contracts -----
    const remote = new ethers.Contract(remoteFeed, AGGREGATOR_ABI, remoteProvider);
    const local  = new ethers.Contract(aggregator,   AGGREGATOR_ABI, sender);

    // ----- Metadata -----
    const [srcDec, dstDec] = await Promise.all([
      remote.decimals() as Promise<number>,
      local.decimals()  as Promise<number>,
    ]);

    let srcDesc = "(unknown)";
    try { srcDesc = await remote.description(); } catch {}

    console.log("\n=== Chainlink → Local Mirror (Hardhat task) ===");
    console.log(`Network (local): ${network.name}`);
    console.log(`Signer         : ${await sender.getAddress?.() ?? sender.address}`);
    console.log(`Remote feed    : ${remoteFeed} (${srcDesc})`);
    console.log(`Remote RPC     : ${remoteRpc}`);
    console.log(`Remote decimals: ${srcDec}`);
    console.log(`Local mock     : ${aggregator}`);
    console.log(`Local decimals : ${dstDec}`);
    console.log(`Poll interval  : ${pollMs} ms`);
    console.log("----------------------------------------------");

    // track last seen remote round/timestamp
    let lastRemoteRound: bigint | null = null;
    let lastRemoteUpdatedAt: bigint | null = null;

    async function readLocal() {
      const [rId, ans, , ts] = await local.latestRoundData();
      return { roundId: BigInt(rId), answer: BigInt(ans), updatedAt: BigInt(ts) };
    }

    async function tick() {
      try {
        let [roundId, answer, , updatedAt] = await remote.latestRoundData();
        const rId  = BigInt(roundId);
        const rAns = BigInt(answer);
        const rUpd = BigInt(updatedAt);

        if (lastRemoteRound !== null && rId === lastRemoteRound) return;
        if (lastRemoteUpdatedAt !== null && rUpd <= lastRemoteUpdatedAt) return;

        const scaled = scaleToDecimals(rAns, srcDec, dstDec);

        const localNow = await readLocal();
        const changed = localNow.answer !== scaled;

        console.log(`[REMOTE] round=${rId} updatedAt=${rUpd} answer(raw:${rAns}) | scaled(${srcDec}→${dstDec})=${scaled}`);

        if (!changed) {
          console.log("→ Local mock already up-to-date, skipping.");
        } else {
          const tx = await local.updateAnswer(scaled);
          console.log(`→ updateAnswer(${scaled}) sent  tx=${tx.hash}`);
          const rcpt = await tx.wait();
          console.log(`→ Mined in block ${rcpt?.blockNumber}`);
        }

        lastRemoteRound = rId;
        lastRemoteUpdatedAt = rUpd;
      } catch (err: any) {
        console.error("tick() error:", err?.message || err);
      }
    }

    // loop
    let running = true;
    process.on("SIGINT", () => { running = false; console.log("\nShutting down…"); });
    process.on("SIGTERM", () => { running = false; console.log("\nShutting down…"); });

    while (running) {
      await tick();
      await new Promise((res) => setTimeout(res, pollMs));
    }
  });
