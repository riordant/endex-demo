// tasks/user/ui/positionsTable.ts
import { ethers as EthersNS } from "ethers";
import { fmtUSD6, parseStatus, parseCloseCause, fmtPnl } from "../../utils";
import {div1e18} from "./equityTable";

type Deps = {
  ethers: typeof EthersNS;
  endex: any;
  signer: any;
  knownIds: bigint[];
  market: string;
  markPx: number;      // oracle mark (float)
  mmBps: number;
  getPendingEquity: (owner: string, id: bigint) => Promise<any>;
  cofhejs: any;
  FheTypes: any;
};

const usd = (x: number, d = 2) =>
  x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const toNumE8 = (x: bigint) => Number(x) / 1e8;
const col = (s: string, w: number) => {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
};
const fromX18ToFloat = (x: bigint) => Number(x) / 1e18;

export async function drawPositionsTable(deps: Deps) {
  const { endex, signer, knownIds, market, markPx, mmBps, getPendingEquity, cofhejs, FheTypes } = deps;
  const m = mmBps / 10_000;

  console.log(
    col("POSITION",      28) +
    col("SIZE",          16) +
    col("EQUITY",        16) +
    col("COLLATERAL",    16) +
    col("PNL",           16) +
    col("ENTRY PRICE",   16) +
    col("MARK PRICE",    16) +
    col("LIQ. PRICE",    16) +
    col("SETTLED PRICE", 16) +
    col("STATUS",        28)
  );

  for (const id of knownIds) {
    let p: any;
    try { p = await endex.getPosition(id); } catch { continue; }

    const isLong = Boolean(p.isLong);
    const collateralUSDC6 = BigInt(p.collateral);
    const collateral = Number(collateralUSDC6) / 1e6;
    const entry = toNumE8(BigInt(p.entryPrice));

    // SIZE (owner-decrypted)
    let sizeUSDC6 = 0n;
    let sizeStr = "—";
    try {
      const sizeDec = await cofhejs.unseal(p.size, FheTypes.Uint256);
      if (sizeDec.success) {
        sizeUSDC6 = BigInt(sizeDec.data);
        sizeStr = "$" + fmtUSD6(sizeUSDC6);
      }
    } catch {}

    // NET VALUE from pendingEquity.equityNet (X18)
    let netValueFloat = BigInt(0);
    let netValueStr = "—";
    try {
      const peq = await getPendingEquity(signer.address, id);
      const eqDec = await cofhejs.unseal(peq.equityNet, FheTypes.Uint256); // X18
      if (eqDec.success) {
        netValueFloat = div1e18(eqDec.data);
        netValueStr = "$" + fmtUSD6(netValueFloat);
      }
    } catch {}

    // PnL = NetValue − Collateral  (display only)
    let pnlStr = "—";
    if (!(netValueFloat == BigInt(0))) {
      const pnl = netValueFloat - collateralUSDC6;
      pnlStr = fmtPnl(pnl);
    }

    // leverage display
    let levStr = "—";
    if (sizeUSDC6 > 0n && collateral > 0) {
      const lev = (Number(sizeUSDC6) / 1e6) / collateral;
      levStr = (lev >= 100 ? lev.toFixed(0) : lev.toFixed(2)) + "x";
    }

    // liq price (approx; oracle model; funding paid at close ⇒ no drift here)
    let liqStr = "—";
    if (sizeUSDC6 > 0n && entry > 0 && mmBps > 0) {
      const S = Number(sizeUSDC6) / 1e6;
      const C = collateral;
      const F = 0;
      if (isLong) {
        const term = 1 - (C - F - m * S) / S;
        liqStr = "$" + usd(entry * term, 2);
      } else {
        const term = 1 + (C - F - m * S) / S;
        liqStr = "$" + usd(entry * term, 2);
      }
    }

    // settled price (if any)
    let settledPx = 0;
    if (p.settlementPrice > 0) settledPx = toNumE8(BigInt(p.settlementPrice));

    const status = parseStatus(p.status);
    const cause  = (status === "Closed" || status === "Liquidated") ? parseCloseCause(p.cause) : "";
    const statusCell = status + (cause ? " / " + cause : "");

    // position cell (single line)
    const positionCell = `${market} • ${levStr} ${isLong ? "Long" : "Short"}`;

    console.log(
      col(positionCell, 28) +
      col(sizeStr,      16) +
      col(netValueStr,  16) +
      col("$" + usd(collateral, 2), 16) +
      col(pnlStr,       16) +
      col("$" + usd(entry, 2),     16) +
      col(Number.isFinite(markPx) ? ("$" + usd(markPx, 2)) : "—", 16) +
      col(liqStr,       16) +
      col(settledPx > 0 ? ("$" + usd(settledPx, 2)) : "—", 16) +
      col(statusCell,   28)
    );
  }
}
