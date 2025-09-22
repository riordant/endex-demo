// tasks/miner.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Reads from .env:
 *   SECONDS   = total seconds to advance (e.g. 3600)
 *   BLOCKS    = number of blocks to mine  (e.g. 12)
 *
 * Example:
 *   SECONDS=3600
 *   BLOCKS=12
 *
 * Then run:
 *   npx hardhat miner --network localhost
 */
task("miner", "Advance time and mine blocks based on .env")
  .setAction(async (_args: any, hre: HardhatRuntimeEnvironment) => {
    const { network } = hre;

    const SECONDS = Number(process.env.SECONDS ?? "0");
    const BLOCKS  = Number(process.env.BLOCKS  ?? "0");

    if (!Number.isFinite(SECONDS) || SECONDS < 0) {
      throw new Error("Invalid SECONDS in .env");
    }
    if (!Number.isFinite(BLOCKS) || BLOCKS < 0) {
      throw new Error("Invalid BLOCKS in .env");
    }
    if (SECONDS === 0 && BLOCKS === 0) {
      console.log("Nothing to do (SECONDS=0 and BLOCKS=0).");
      return;
    }

    // If we have both seconds and blocks, use hardhat_mine with a per-block interval,
    // then finish any leftover seconds via evm_increaseTime + evm_mine.
    // If either is zero, fall back to the specific method.
    const provider = network.provider;

    if (BLOCKS > 0 && SECONDS > 0) {
      const interval = Math.floor(SECONDS / BLOCKS);   // seconds between blocks
      const leftover = SECONDS - interval * BLOCKS;

      // Mine BLOCKS blocks with `interval` seconds between them
      // hardhat_mine params are hex strings
      const blocksHex   = "0x" + BLOCKS.toString(16);
      const intervalHex = "0x" + Math.max(interval, 1).toString(16); // interval must be >= 1
      await provider.send("hardhat_mine", [blocksHex, intervalHex]); // mines + advances time per block. :contentReference[oaicite:2]{index=2}

      // If we need a few extra seconds to hit the exact total, advance and mine one more block
      if (leftover > 0) {
        await provider.send("evm_increaseTime", [leftover]);        // advance timestamp delta. :contentReference[oaicite:3]{index=3}
        await provider.send("evm_mine");                             // materialize the time change. :contentReference[oaicite:4]{index=4}
      }

      console.log(`✅ Advanced ~${SECONDS}s and mined ${BLOCKS}${leftover ? " + 1" : ""} blocks.`);

    } else if (BLOCKS > 0) {
      // Only mine blocks (no time change unless your node auto-increments)
      const blocksHex = "0x" + BLOCKS.toString(16);
      await provider.send("hardhat_mine", [blocksHex]);              // mine N blocks. :contentReference[oaicite:5]{index=5}
      console.log(`✅ Mined ${BLOCKS} blocks.`);

    } else {
      // Only advance time, then mine one block to commit the new timestamp
      await provider.send("evm_increaseTime", [SECONDS]);            // advance timestamp. :contentReference[oaicite:6]{index=6}
      await provider.send("evm_mine");                               // mine one block. :contentReference[oaicite:7]{index=7}
      console.log(`✅ Advanced ${SECONDS}s and mined 1 block.`);
    }
  });
