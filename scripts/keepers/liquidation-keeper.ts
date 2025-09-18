/* scripts/keepers/liquidation-keeper.ts
   Listens to MockV3Aggregator price updates and runs liquidation + settlement.
   Ethers v6 + ts-node.

   ENV / CLI:
     LOCAL_RPC                 (default http://127.0.0.1:8545)
     LOCAL_PRIVATE_KEY         (required)
     ENDEX                     (required)
     AGGREGATOR                (required: your local MockV3Aggregator)
     FLAG_WAIT_MS              (default 10000)  // wait after requestLiqChecks before finalize
     SETTLE_WAIT_MS            (default 10000)  // wait after finalize before settlePositions
*/

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

/* eslint-disable @typescript-eslint/no-var-requires */
const EndexABI =
  require("../../artifacts/contracts/IEndex.sol/IEndex.json").abi; // or Endex.json if you prefer
const MockV3AggregatorABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  // emits on price updates; signature per AggregatorInterface
  // event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
];

type Opts = {
  localRpc: string;
  privateKey: string;
  endex: string;
  aggregator: string;
  flagWaitMs: number;
  settleWaitMs: number;
};

function parseArgs(): Opts {
  const argv = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (k?.startsWith("--") && v) argv.set(k.slice(2), v);
  }

  const localRpc = argv.get("localRpc") || process.env.LOCAL_RPC || "http://127.0.0.1:8545";
  const privateKey = argv.get("privateKey") || process.env.LOCAL_PRIVATE_KEY || "";
  const endex = argv.get("endex") || process.env.ENDEX || "";
  const aggregator = argv.get("aggregator") || process.env.AGGREGATOR || "";
  const flagWaitMs = Number(argv.get("flagWaitMs") || process.env.FLAG_WAIT_MS || 10_000);
  const settleWaitMs = Number(argv.get("settleWaitMs") || process.env.SETTLE_WAIT_MS || 10_000);

  if (!privateKey || !endex || !aggregator) {
    console.error(
      [
        "Missing required args:",
        `  --privateKey / LOCAL_PRIVATE_KEY : ${privateKey ? "(provided)" : "(missing)"}`,
        `  --endex      / ENDEX             : ${endex || "(missing)"}`,
        `  --aggregator / AGGREGATOR        : ${aggregator || "(missing)"}`,
        `  --localRpc   / LOCAL_RPC         : ${localRpc}`,
        `  --flagWaitMs / FLAG_WAIT_MS      : ${flagWaitMs}`,
        `  --settleWaitMs / SETTLE_WAIT_MS  : ${settleWaitMs}`,
      ].join("\n")
    );
    process.exit(1);
  }
  return { localRpc, privateKey, endex, aggregator, flagWaitMs, settleWaitMs };
}

async function getOpenPositionIds(endex: ethers.Contract): Promise<bigint[]> {
  const nextId: bigint = await endex.nextPositionId(); // assumed starts at 1
  const ids: bigint[] = [];
  for (let id = 1n; id < nextId; id++) {
    try {
      const pos = await endex.getPosition(id);
      const status: number = Number(pos.status ?? pos[/* fallback */ "status"]);
      if (status === 0) ids.push(id); // Open
    } catch {}
  }
  return ids;
}

async function getAwaitingSettlementIds(endex: ethers.Contract): Promise<bigint[]> {
  const nextId: bigint = await endex.nextPositionId();
  const ids: bigint[] = [];
  for (let id = 1n; id < nextId; id++) {
    try {
      const pos = await endex.getPosition(id);
      const status: number = Number(pos.status ?? pos["status"]);
      if (status === 1) ids.push(id); // AwaitingSettlement
    } catch {}
  }
  return ids;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs();

  const provider = new ethers.JsonRpcProvider(opts.localRpc);
  const wallet = new ethers.Wallet(opts.privateKey, provider);

  const endex = new ethers.Contract(opts.endex, EndexABI, wallet);
  const aggregator = new ethers.Contract(opts.aggregator, MockV3AggregatorABI, provider);

  console.log("=== Endex Liquidation/Settlement Keeper ===");
  console.log(`Local RPC     : ${opts.localRpc}`);
  console.log(`Endex         : ${opts.endex}`);
  console.log(`MockV3Agg     : ${opts.aggregator}`);
  console.log(`Flag wait     : ${opts.flagWaitMs} ms`);
  console.log(`Settle wait   : ${opts.settleWaitMs} ms`);
  console.log("-------------------------------------------");

  // Prevent overlapping cycles if multiple price updates land close together
  let busy = false;

  async function cycle(reason: string) {
    if (busy) {
      console.log(`(busy) Skipping cycle triggered by: ${reason}`);
      return;
    }
    busy = true;
    try {
      console.log(`\n▶ Cycle triggered by: ${reason}`);

      // 1) Sweep liquidations (request -> wait -> finalize)
      const openIds = await getOpenPositionIds(endex);
      console.log(`Open positions: ${openIds.length} ${openIds.length ? `[${openIds.join(",")}]` : ""}`);
      let shouldSettle = true;
      if (openIds.length > 0) {
        const tx1 = await endex.requestLiqChecks(openIds);
        console.log(`requestLiqChecks tx=${tx1.hash}`);
        await tx1.wait();

        console.log(`waiting FLAG_WAIT_MS=${opts.flagWaitMs}ms for liq flag decrypt…`);
        await sleep(opts.flagWaitMs);

        const tx2 = await endex.finalizeLiqChecks(openIds);
        console.log(`finalizeLiqChecks tx=${tx2.hash}`);
        await tx2.wait();
      } else {
        shouldSettle = false;
        console.log("No open positions → skipping liq request/finalize.");
      }
      
      if(shouldSettle) {
        // 2) After finalize, wait for equity decrypt → then settle awaiting
        console.log(`waiting SETTLE_WAIT_MS=${opts.settleWaitMs}ms for equity decrypt…`);
        await sleep(opts.settleWaitMs);

        const awaiting = await getAwaitingSettlementIds(endex);
        console.log(`AwaitingSettlement: ${awaiting.length} ${awaiting.length ? `[${awaiting.join(",")}]` : ""}`);

        if (awaiting.length > 0) {
          // You can batch if needed; here we do one call
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

  // Initial catch-up on start
  //await cycle("startup");

  // Subscribe to price updates on the aggregator
  let lastBlock = await provider.getBlockNumber();
  
  provider.on("block", async (bn: number) => {
    console.log("new block..");
    // Only query from the next block we haven’t processed
    const from = 0;
    const to = 13;
    console.log("to: ", to)
    console.log("from: ", from)
    if (to < from) { 
        lastBlock = bn; return; 
    }
  
    try {
      // Ask ethers to get all AnswerUpdated logs in [from, to]
      // You can use the fragment name directly:
      const logs = await aggregator.queryFilter("AnswerUpdated", from-1, to+1);
      console.log(
          "logs length:",
          logs.length
      )
  
      if (logs.length > 0) {
        console.log(`Detected ${logs.length} AnswerUpdated log(s) in blocks ${from}..${to}`);
        await cycle(`AnswerUpdated x${logs.length}`);
      } else {
          console.log("No AnswerUpdated logs found.")
      }
    } catch (e: any) {
      console.error("block poll error:", e?.message || e);
    } finally {
      lastBlock = bn;
    }
  });

  // Graceful shutdown
  process.on("SIGINT", () => { console.log("\nShutting down…"); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\nShutting down…"); process.exit(0); });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
