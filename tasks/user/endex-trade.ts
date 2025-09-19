// tasks/user/endex-trade.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { cofhejs_initializeWithHardhatSigner } from "cofhe-hardhat-plugin";
import {coprocessor, encryptUint256, fmtPriceE8, fmtUSD6, getDeployment, pad, parseUsd6} from "../utils";

task("endex-trade", "Open or close a position (interactive if no args)")
  .addOptionalParam("mode", "o=open, c=close")
  .addOptionalParam("collateral", "Collateral USDC (6d), e.g. 10,000")
  .addOptionalParam("side", "l=long, s=short")
  .addOptionalParam("lev", "Leverage 1-5")
  .addOptionalParam("endex", "Override Endex address")
  .addOptionalParam("usdc", "Override USDC address")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    // signer & cofhe init (this sets up CRS/PubKey)
    const [signer] = await ethers.getSigners();
    console.log(`\nNetwork: ${network.name}`);
    console.log(`Signer : ${signer.address}`);
    await cofhejs_initializeWithHardhatSigner(hre, signer); // <-- critical init for encryption 👈 :contentReference[oaicite:1]{index=1}

    // resolve addresses (deployments or overrides)
    const endexAddr = args.endex || getDeployment(network.name, "Endex");
    const usdcAddr  = args.usdc  || getDeployment(network.name, "USDC");
    if (!endexAddr || !usdcAddr) {
      console.error("Missing Endex/USDC deployment. Provide --endex/--usdc or deploy first.");
      return;
    }
    console.log(`Endex : ${endexAddr}`);
    console.log(`USDC  : ${usdcAddr}\n`);

    // get contract instances from artifacts (hre.ethers uses compiled ABIs) :contentReference[oaicite:2]{index=2}
    const endex = await ethers.getContractAt("Endex", endexAddr, signer);
    const usdc  = await ethers.getContractAt("MintableToken", usdcAddr, signer);

    // interactive prompt if needed
    const rl = readline.createInterface({ input, output });
    const ask = async (q: string) => (await rl.question(q)).trim();

    const mode = (args.mode || await ask("Open or Close? [o/c]: ")).toLowerCase();
    if (mode !== "o" && mode !== "c") {
      console.log("Please type 'o' or 'c'.");
      await rl.close();
      return;
    }

    if (mode === "o") {
      // ---- OPEN FLOW ----
      const collateralStr = args.collateral || await ask("Enter collateral (USDC, 6 decimals, e.g. 10,000): ");
      const collateralUSDC6 = parseUsd6(collateralStr);

      const side = (args.side || await ask("Enter side: long(l) / short(s): ")).toLowerCase();
      if (!["l", "s"].includes(side)) throw new Error("Invalid side; use 'l' or 's'");
      const isLong = side === "l";

      const levNum = Number(args.lev || await ask("Enter leverage (1-5): "));
      if (!Number.isFinite(levNum) || levNum < 1 || levNum > 5) throw new Error("Invalid leverage; must be 1-5");

      const sizeUSDC6 = collateralUSDC6 * BigInt(levNum);
      const sizeEnc = await encryptUint256(sizeUSDC6);

      // mint & approve
      const mintTx = await usdc.mint(signer.address, collateralUSDC6);
      await mintTx.wait();
      const allowance = await usdc.allowance(signer.address, endexAddr);
      if (allowance < collateralUSDC6) {
        const approveTx = await usdc.approve(endexAddr, collateralUSDC6);
        await approveTx.wait();
      }

      console.log(`\nOpening: ${isLong ? "LONG" : "SHORT"}  size=$${fmtUSD6(sizeUSDC6)}  collateral=$${fmtUSD6(collateralUSDC6)} lev=${levNum}x`);
      // artifacts will have the exact InEuint256 type; most builds accept raw bytes for `size_`
      const tx = await endex.openPosition(isLong, sizeEnc, collateralUSDC6, 0, 0);
      console.log(`→ tx: ${tx.hash}`);
      await tx.wait();
      console.log("✅ Position opened.\n");

    } else {
      // ---- CLOSE FLOW ----
      console.log("\n=== Close Position ===");

      const nextId: bigint = await endex.nextPositionId();
      const ownedOpen: Array<{ id: bigint; isLong: boolean; collateral: bigint; entryPrice: bigint }> = [];

      for (let id = 1n; id < nextId; id++) {
        try {
          const p = await endex.getPosition(id);
          // Position struct: (owner, positionId, isLong, size(bytes), collateral, entryPrice, ..., status, cause, ...)
          const owner: string = p.owner;
          const status: number = Number(p.status);
          if (owner.toLowerCase() === signer.address.toLowerCase() && status === 0) {
            ownedOpen.push({
              id,
              isLong: Boolean(p.isLong),
              collateral: BigInt(p.collateral),
              entryPrice: BigInt(p.entryPrice),
            });
          }
        } catch {}
      }

      if (!ownedOpen.length) {
        console.log("No OPEN positions owned by this signer.\n");
        await rl.close();
        return;
      }

      console.log("\nYour OPEN positions:");
      console.log("  " + pad("Idx", 5) + pad("PosID", 10) + pad("Side", 8) + pad("Collateral(USDC)", 20) + pad("EntryPx", 16));
      ownedOpen.forEach((p, i) => {
        console.log(
          "  " +
          pad(String(i), 5) +
          pad(String(p.id), 10) +
          pad(p.isLong ? "LONG" : "SHORT", 8) +
          pad("$" + fmtUSD6(p.collateral), 20) +
          pad("$" + fmtPriceE8(p.entryPrice), 16)
        );
      });

      const idxStr = await ask("\nEnter index to close (e.g., 0): ");
      const idx = Number(idxStr);
      if (!Number.isInteger(idx) || idx < 0 || idx >= ownedOpen.length) {
        await rl.close();
        throw new Error("Invalid index.");
      }
      const chosen = ownedOpen[idx];

      const tx1 = await endex.closePosition(chosen.id);
      console.log(`Submitting closePosition(${chosen.id})… tx=${tx1.hash}`);
      await tx1.wait();
      console.log("✅ Close submitted. \n");
      await coprocessor();
      const tx2 = await endex.settlePositions([chosen.id]);
      console.log(`Submitting settlePositions(${chosen.id})… tx=${tx2.hash}`);
      await tx2.wait();
      console.log("✅ Close settled.");
    }

    await rl.close();
  });
