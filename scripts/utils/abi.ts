// scripts/utils/abi.ts
import * as fs from "fs";
import * as path from "path";

/** Reads Hardhat artifact JSON and returns its `abi` array. */
export function loadAbiFromArtifact(relativeArtifactPath: string): any[] {
  // relativeArtifactPath examples:
  //  "contracts/Endex.sol/Endex.json"
  //  "contracts/mocks/MintableToken.sol/MintableToken.json"
  const full = path.join(process.cwd(), "artifacts", relativeArtifactPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Artifact not found: ${full}. Did you run \`hardhat compile\`?`);
  }
  const json = JSON.parse(fs.readFileSync(full, "utf8"));
  if (!json.abi) {
    throw new Error(`No 'abi' key in artifact: ${full}`);
  }
  return json.abi;
}
