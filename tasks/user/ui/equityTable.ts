// tasks/user/ui/equityTable.ts
import { ethers as EthersNS } from "ethers";
import {fmtPnl, fmtUSD6} from "../../utils";

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


export const div1e18 = (x: any) => BigInt(x / BigInt(1e18));

const usd = (x: number, d = 2) =>
  x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const col = (s: string, w: number) => {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
};
const fromX18ToFloat = (x: bigint) => BigInt(x / BigInt(1e18));

async function unsealUintX18(cofhejs: any, FheTypes: any, sealed: any) {
  try {
    const r = await cofhejs.unseal(sealed, FheTypes.Uint256);
    if (r.success) return BigInt(r.data);
  } catch {
      return BigInt(0);
  }
}

// “gain − loss” to signed $ string (from X18)
function fmtNetX18(gainX18: any, lossX18: any): string {
  if (gainX18 === null || lossX18 === null) return "—";
  const net = fromX18ToFloat(BigInt( gainX18 ) - BigInt( lossX18 ));
  return fmtPnl(net);
}

export async function drawEquityTable(deps: Deps) {
  const { endex, signer, knownIds, market, getPendingEquity, cofhejs, FheTypes } = deps;

  console.log("Equity");
  console.log(
    col("POSITION",        28) +
    col("EQUITY",          16) +   // equityNet
    col("NET",             16) +   // pnl (gain-loss)
    col("FUNDING",         16) +   // funding (gain-loss)
    col("IMPACT (ENTRY)",  18) +   // entryImpact (gain-loss)
    col("IMPACT (EXIT)",   18) +   // exitImpact (gain-loss)
    col("CLOSE FEE",       16)
  );

  for (const id of knownIds) {
    // Read the PendingEquity struct (public getter on EndexView)
    let peq: any;
    try { peq = await getPendingEquity(signer.address, id); } catch { continue; }
    if (!peq) continue;

    // Unseal parts
    const eqNetX18   = await unsealUintX18(cofhejs, FheTypes, peq.equityNet);
    const feeX18     = await unsealUintX18(cofhejs, FheTypes, peq.closeFee);

    const pnlGainX18 = await unsealUintX18(cofhejs, FheTypes, peq.pnl.gainX18);
    const pnlLossX18 = await unsealUintX18(cofhejs, FheTypes, peq.pnl.lossX18);

    const fundGainX18 = await unsealUintX18(cofhejs, FheTypes, peq.funding.gainX18);
    const fundLossX18 = await unsealUintX18(cofhejs, FheTypes, peq.funding.lossX18);

    const entGainX18 = await unsealUintX18(cofhejs, FheTypes, peq.entryImpact.gainX18);
    const entLossX18 = await unsealUintX18(cofhejs, FheTypes, peq.entryImpact.lossX18);

    const exitGainX18 = await unsealUintX18(cofhejs, FheTypes, peq.exitImpact.gainX18);
    const exitLossX18 = await unsealUintX18(cofhejs, FheTypes, peq.exitImpact.lossX18);

    // Position label
    const positionCell = `${market} • #${id}`;

    //console.log("entry gain: ", entGainX18);
    //console.log("entry loss: ", entLossX18);
    //console.log("exit gain: ", exitGainX18);
    //console.log("exit loss: ", exitLossX18);
    //console.log("eqNetX18: ", eqNetX18);

    // Render line
    console.log(
      col(positionCell,   28) +
      col(eqNetX18 !== null ? ("$" + fmtUSD6(div1e18(eqNetX18))) : "—", 16) +
      col(fmtNetX18(pnlGainX18,  pnlLossX18), 16) +
      col(fmtNetX18(fundGainX18, fundLossX18), 16) +
      col(fmtNetX18(entGainX18,  entLossX18), 18) +
      col(fmtNetX18(exitGainX18, exitLossX18),18) +
      col(feeX18 !== null ? ("$" + fmtUSD6(feeX18 as bigint)) : "—", 16)
    );
  }
}
