// tasks/user/dashboard.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as readline from "node:readline";
import { cofhejs_initializeWithHardhatSigner } from "cofhe-hardhat-plugin";
import { cofhejs, FheTypes } from "cofhejs/node";

// Optional shared utils if you have them already.
// If not, keep the tiny helpers inline below.
import {
  getDeployment, // resolve deployments/<net>/<Name>.json .address
  clearScreen,
  pad,
  fmtUSD6,
  parseStatus,
  parseCloseCause
} from "../utils";

task("user-dashboard", "Live user dashboard with CoFHE decrypts (size, liq flag)")
  .addOptionalParam("endex", "Override Endex address")
  .addOptionalParam("refreshMs", "Refresh interval (ms), default 10000")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    // ---- Signer + CoFHE init (critical: sets CRS/PublicKey for unseal) ----
    const [signer] = await ethers.getSigners();
    await cofhejs_initializeWithHardhatSigner(hre, signer);

    // ---- Resolve Endex address and bind contract ----
    const endexAddr = args.endex || getDeployment?.(network.name, "Endex");
    if (!endexAddr) {
      console.error("Missing Endex address. Use --endex or deploy first.");
      return;
    }
    const endex = await ethers.getContractAt("Endex", endexAddr, signer);

    const refreshMs = Number(args.refreshMs ?? 10_000);

    async function draw() {
      clearScreen();
      const now = new Date();
      console.log(`Endex — User Dashboard (${network.name})  ${now.toLocaleString()}`);
      console.log("".padEnd(100, "─"));
      console.log(`User  : ${signer.address}`);
      console.log(`Endex : ${endexAddr}\n`);

      // Optional: maintenance margin bps if your contract exposes it
      let mmBps: number | undefined;
      try { mmBps = Number(await (endex as any).MAINT_MARGIN_BPS()); } catch {}

      // Scan positions owned by this signer
      let nextId: bigint = 1n;
      try { nextId = await endex.nextPositionId(); } catch {}
      const positions: any[] = [];
      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id);
          if (p.owner?.toLowerCase() === signer.address.toLowerCase()) positions.push(p);
        } catch {}
      }

      if (positions.length === 0) {
        console.log("No positions for this user.");
        console.log(`Next refresh in ${(refreshMs/1000)|0}s — Ctrl+C to exit`);
        return;
      }

      console.log(
        pad("ID", 6) +
        pad("Side", 8) +
        pad("Size (USDC)", 18) +
        pad(mmBps !== undefined ? `Maint@${mmBps}bps` : "Maint", 18) +
        pad("Status", 18) +
        pad("LiqPend", 10) +
        pad("CloseCause", 14)
      );

      for (const p of positions) {
        // p fields follow your IEndex.Position layout
        const posId: bigint = BigInt(p.positionId);
        const isLong: boolean = Boolean(p.isLong);
        const statusNum: bigint = p.status;
        const causeNum: bigint = p.cause;
        const collateral: bigint = BigInt(p.collateral);
        const entryPrice: bigint = BigInt(p.entryPrice);

        // ---- Decrypt size (owner-only) ----
        let sizeUSDC6 = "—";
        try {
          // Try simplest: value is already a sealed output
          let dec = await cofhejs.unseal(p.size, FheTypes.Uint256);
          if (dec.success) {
            sizeUSDC6 = fmtUSD6(dec.data);
          }
        } catch {
          // keep "—"
        }

        // ---- Decrypt pendingLiqFlagEnc (globally viewable per design) ----
        let liqFlag = "—";
        try {
          let dec = await cofhejs.unseal(p.pendingLiqFlagEnc, FheTypes.Bool);
          if (dec.success) {
            liqFlag = Boolean(dec.data) ? "YES" : "no";
          }
        } catch {}

        const status = parseStatus(statusNum);
        const cause  = (status === "Closed" || status === "Liquidated") ? parseCloseCause(causeNum) : "";

        // maintenance margin (if mmBps and size available)
        let maint = "—";
        if (mmBps !== undefined && sizeUSDC6 !== "—") {
          const sz = Number(sizeUSDC6.replace(/,/g, ""));
          const m = sz * (mmBps / 10_000);
          maint = m.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        console.log(
          pad(String(posId), 6) +
          pad(isLong ? "LONG" : "SHORT", 8) +
          pad(sizeUSDC6, 18) +
          pad(maint, 18) +
          pad(status, 18) +
          pad(liqFlag, 10) +
          pad(cause, 14)
        );
      }

      console.log("\nNext refresh in " + ((refreshMs/1000)|0) + "s — Ctrl+C to exit");
    }

    // First draw, then interval
    await draw();
    const timer = setInterval(draw, refreshMs);

    // Keep the process alive / Ctrl+C handling
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
      if (key.sequence === "\u0003") {
        clearInterval(timer);
        process.exit(0);
      }
    });


   // Keep the task alive until Ctrl+C, and clean up on exit
   await new Promise<void>((resolve) => {
     const shutdown = () => {
       clearInterval(timer);
       try {
         if (process.stdin.isTTY) process.stdin.setRawMode(false);
       } catch {}
       resolve();
     };
     process.on("SIGINT", shutdown);
     process.on("SIGTERM", shutdown);
   });
  });
