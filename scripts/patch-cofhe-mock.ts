// scripts/patch-cofhe-mock.ts
import { promises as fs } from "fs";
import path from "path";
import process from "process";

const targetFile: string = path.join(
  process.cwd(),
  "node_modules",
  "@fhenixprotocol",
  "cofhe-mock-contracts",
  "MockTaskManager.sol"
);

const originalLine = "uint64 asyncOffset = uint64((block.timestamp % 10) + 1);";
const patchedLine  = "uint64 asyncOffset = 1;";

// Handles spacing/formatting variations
const originalRegex: RegExp =
  /uint64\s+asyncOffset\s*=\s*uint64\(\s*\(block\.timestamp\s*%\s*10\)\s*\+\s*1\s*\)\s*;/;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const hasFile = await exists(targetFile);
  if (!hasFile) {
    console.error(`[patch] File not found: ${targetFile}`);
    process.exit(0); // don't fail install
  }

  const src: string = await fs.readFile(targetFile, "utf8");

  // Already patched?
  if (src.includes(patchedLine)) {
    console.log("[patch] Already patched. Nothing to do.");
    return;
  }

  let updated: string | null = null;

  if (src.includes(originalLine)) {
    updated = src.replace(originalLine, patchedLine);
  } else if (originalRegex.test(src)) {
    updated = src.replace(originalRegex, patchedLine);
  }

  if (updated == null) {
    console.error("[patch] Could not find target line to replace. Aborting.");
    process.exit(1);
  }

  await fs.writeFile(targetFile, updated, "utf8");
  console.log("[patch] Successfully patched MockTaskManager.sol");
}

main().catch((err) => {
  console.error("[patch] Unexpected error:", err);
  process.exit(1);
});
