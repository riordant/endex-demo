// tasks/user/ui/equityTable.ts
import { ethers as EthersNS } from "ethers";
import { fmtPnl, fmtUSD6, unsealEint256 } from "../../utils";

type Deps = {
  ethers: typeof EthersNS;
  endex: any;
  signer: any;
  knownIds: bigint[];
  market: string;
  getPendingEquity: (owner: string, id: bigint) => Promise<any>;
  cofhejs: any;
  FheTypes: any;
};

export const div1e18 = (x: bigint) => BigInt(x / BigInt(1e18));

const usd = (x: number, d = 2) =>
  x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const col = (s: string, w: number) => {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
};

async function unsealUintX18(cofhejs: any, FheTypes: any, sealed: any) {
  try {
    const r = await cofhejs.unseal(sealed, FheTypes.Uint256);
    if (r.success) return BigInt(r.data);
  } catch {
    return BigInt(0);
  }
  return BigInt(0);
}

export async function drawEquityTable(deps: Deps) {
  const { endex, signer, knownIds, market, getPendingEquity, cofhejs, FheTypes } = deps;

  console.log("Equity");
  console.log(
    col("POSITION",        28) +
    col("PAYOUT",          16) +   // equityNet
    col("NET",             16) +   // pnl (gain-loss)
    col("FUNDING",         16) +   // funding (gain-loss)
    col("IMPACT (ENTRY)",  18) +   // entryImpact (gain-loss)
    col("IMPACT (EXIT)",   18) +   // exitImpact (gain-loss)
    col("CLOSE FEE",       16)
  );

  for (const id of knownIds) {
    // Skip if status < Open
    let p: any;
    try { p = await endex.getPosition(id); } catch { continue; }
    const statusNum = Number(p.status ?? p["status"] ?? -1);
    if (statusNum < 2) continue;

    // Read the PendingEquity struct (public getter)
    let peq: any;
    try { peq = await getPendingEquity(signer.address, id); } catch { continue; }
    if (!peq) continue;

    // Unseal parts
    const eqNetX18     = await unsealUintX18(cofhejs, FheTypes, peq.equityNet);
    const feeX18       = await unsealUintX18(cofhejs, FheTypes, peq.closeFee);

    const pnlX18   = await unsealEint256(peq.pnl);

    const fundX18  = await unsealEint256(peq.funding);

    const entX18   = await unsealEint256(peq.entryImpact);

    const exitX18   = await unsealEint256(peq.exitImpact);

    // Position label
    const positionCell = `${market} • #${id}`;
    const finalEqNetX18 = div1e18(eqNetX18) - feeX18;

    // Render line
    console.log(
      col(positionCell,   28) +
      col(eqNetX18 !== null ? ("$" + fmtUSD6(finalEqNetX18)) : "—", 16) +
      col(fmtPnl(div1e18(pnlX18)), 16) +
      col(fmtPnl(div1e18(fundX18)), 16) +
      col(fmtPnl(div1e18(entX18)), 18) +
      col(fmtPnl(div1e18(exitX18)), 18) +
      col(feeX18 !== null ? ("-$" + fmtUSD6(feeX18 as bigint)) : "—", 16)
    );
  }
}
