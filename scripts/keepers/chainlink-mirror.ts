/* scripts/keepers/chainlink-mirror.ts
   Long-running keeper: mirror a remote Chainlink feed to a local MockV3Aggregator.
   Ethers v6, no extra deps. Run with ts-node.

   Reads:
     - REMOTE_RPC          (e.g., Sepolia / Mainnet RPC)
     - REMOTE_FEED         (Chainlink proxy address, e.g., ETH/USD)
     - LOCAL_RPC           (default: http://127.0.0.1:8545)
     - AGGREGATOR          (your deployed MockV3Aggregator on localhost)
     - LOCAL_PRIVATE_KEY   (signer to call updateAnswer on localhost)
     - POLL_MS             (default 3000)

   Usage:
     ts-node scripts/keepers/chainlink-mirror.ts \
       --remoteFeed 0x... --aggregator 0x... \
       --remoteRpc https://sepolia.infura.io/v3/KEY \
       --localRpc http://127.0.0.1:8545 \
       --privateKey 0xabc... --pollMs 3000
*/

import { ethers } from "ethers";
import * as dotenv from 'dotenv';
dotenv.config();

type Opts = {
  remoteRpc: string;
  remoteFeed: string;
  localRpc: string;
  aggregator: string;
  privateKey: string;
  pollMs: number;
};

function parseArgs(): Opts {
  const argv = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (k?.startsWith("--") && v) argv.set(k.slice(2), v);
  }

  const remoteRpc =
    argv.get("remoteRpc") || process.env.REMOTE_RPC || "";
  console.log("remoteRpc: ", remoteRpc);
  const remoteFeed =
    argv.get("remoteFeed") || process.env.REMOTE_FEED || "";
  const localRpc =
    argv.get("localRpc") || process.env.LOCAL_RPC || "http://127.0.0.1:8545";
  const aggregator =
    argv.get("aggregator") || process.env.AGGREGATOR || "";
  const privateKey =
    argv.get("privateKey") || process.env.LOCAL_PRIVATE_KEY || "";
  const pollMs =
    Number(argv.get("pollMs") || process.env.POLL_MS || 3000);

  if (!remoteRpc || !remoteFeed || !aggregator || !privateKey) {
    console.error(
      [
        "Missing required args:",
        `  --remoteRpc / REMOTE_RPC         : ${remoteRpc || "(missing)"}`,
        `  --remoteFeed / REMOTE_FEED       : ${remoteFeed || "(missing)"}`,
        `  --aggregator / AGGREGATOR         : ${aggregator || "(missing)"}`,
        `  --privateKey / LOCAL_PRIVATE_KEY : ${privateKey ? "(provided)" : "(missing)"}`,
        `  --localRpc / LOCAL_RPC           : ${localRpc}`,
        `  --pollMs   / POLL_MS             : ${pollMs}`,
      ].join("\n")
    );
    process.exit(1);
  }

  return { remoteRpc, remoteFeed, localRpc, aggregator, privateKey, pollMs };
}

// Minimal ABIs
const AggregatorV3InterfaceABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

const MockV3AggregatorABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function updateAnswer(int256 _answer) public",
];

function scaleToDecimals(value: bigint, from: number, to: number): bigint {
  if (from === to) return value;
  if (from < to) {
    const mul = 10n ** BigInt(to - from);
    return value * mul;
  } else {
    const div = 10n ** BigInt(from - to);
    return value / div;
  }
}

async function main() {
  const opts = parseArgs();

  const srcProvider = new ethers.JsonRpcProvider(opts.remoteRpc);
  const dstProvider = new ethers.JsonRpcProvider(opts.localRpc);
  const dstWallet = new ethers.Wallet(opts.privateKey, dstProvider);

  const src = new ethers.Contract(opts.remoteFeed, AggregatorV3InterfaceABI, srcProvider);
  const dst = new ethers.Contract(opts.aggregator, MockV3AggregatorABI, dstWallet);

  // Fetch metadata
  const [srcDec, dstDec] = await Promise.all([
    src.decimals() as Promise<number>,
    dst.decimals() as Promise<number>,
  ]);

  let srcDesc = "(unknown)";
  try { srcDesc = await src.description(); } catch {}

  console.log("=== Chainlink → Local Mirror Keeper ===");
  console.log(`Source feed      : ${opts.remoteFeed}  (${srcDesc})`);
  console.log(`Source RPC       : ${opts.remoteRpc}`);
  console.log(`Source decimals  : ${srcDec}`);
  console.log(`Local mock       : ${opts.aggregator}`);
  console.log(`Local RPC        : ${opts.localRpc}`);
  console.log(`Local decimals   : ${dstDec}`);
  console.log(`Poll interval    : ${opts.pollMs} ms`);
  console.log("---------------------------------------");

  // Track the last remote update we acted on
  let lastRemoteRound: bigint | null = null;
  let lastRemoteUpdatedAt: bigint | null = null;

  // Also track what's currently in the local mock to avoid redundant txs
  async function readLocal(): Promise<{ roundId: bigint; answer: bigint; updatedAt: bigint }> {
    const [lrRound, lrAns, , lrUpdatedAt] = await dst.latestRoundData();
    return {
      roundId: BigInt(lrRound),
      answer: BigInt(lrAns),
      updatedAt: BigInt(lrUpdatedAt),
    };
  }

  async function tick() {
    try {
      const [roundId, answer, , updatedAt] = await src.latestRoundData();
      const rId = BigInt(roundId);
      const rAns = BigInt(answer);
      const rUpdated = BigInt(updatedAt);

      if (lastRemoteRound !== null && rId === lastRemoteRound) {
        // no new round
        return;
      }
      if (lastRemoteUpdatedAt !== null && rUpdated <= lastRemoteUpdatedAt) {
        // stale or same timestamp
        return;
      }

      // Normalize to local decimals
      const scaled = scaleToDecimals(rAns, srcDec, dstDec);

      const localNow = await readLocal();
      const isChange = localNow.answer !== scaled;

      console.log(
        `[REMOTE] round=${rId} updatedAt=${rUpdated} answer(raw:${rAns})  | scaled(${srcDec}→${dstDec})=${scaled}`
      );

      if (!isChange) {
        console.log("→ Local mock already has this value. Skipping update.");
      } else {
        const tx = await dst.updateAnswer(scaled);
        console.log(`→ Sent updateAnswer(${scaled})  tx=${tx.hash}`);
        const rcpt = await tx.wait();
        console.log(`→ Mined in block ${rcpt?.blockNumber}`);
      }

      lastRemoteRound = rId;
      lastRemoteUpdatedAt = rUpdated;
    } catch (err: any) {
      console.error("tick() error:", err?.message || err);
    }
  }

  // Main loop with simple backoff on errors
  let running = true;
  process.on("SIGINT", () => { running = false; console.log("\nShutting down…"); });
  process.on("SIGTERM", () => { running = false; console.log("\nShutting down…"); });

  while (running) {
    await tick();
    await new Promise((res) => setTimeout(res, opts.pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
