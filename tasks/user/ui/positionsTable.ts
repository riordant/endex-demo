// tasks/user/ui/positionsTable.ts
import { ethers as EthersNS } from "ethers";
import { fmtUSD6, parseStatus, parseCloseCause, fmtPnl, decryptBool, usd } from "../../utils";
import { div1e18 } from "./equityTable";

type Deps = {
  ethers: typeof EthersNS;
  endex: any;
  signer: any;
  knownIds: bigint[];
  market: string;
  mmBps: number;
  getPendingEquity: (owner: string, id: bigint) => Promise<any>;
  cofhejs: any;
  FheTypes: any;
};

const toNumE8 = (x: bigint) => Number(x) / 1e8;
const col = (s: string, w: number) => {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
};

export async function drawPositionsTable(deps: Deps) {
  const { endex, signer, knownIds, market, mmBps, getPendingEquity, cofhejs, FheTypes } = deps;
  const m = mmBps / 10_000;

  console.log(
    col("POSITION",      28) +
    col("SIZE",          16) +
    col("EQUITY",        16) +
    col("COLLATERAL",    16) +
    col("PNL",           16) +
    col("ENTRY PRICE",   16) +
    col("LIQ. PRICE",    16) +
    col("SETTLED PRICE", 16) +
    col("STATUS",        28)
  );

  for (const id of knownIds) {
    let p: any;
    try { p = await endex.getPosition(id); } catch { continue; }

    // --- Status gate ---
    const statusNum = Number(p.status ?? p["status"] ?? -1);
    const isPreOpen = statusNum < 2; // 0=Requested, 1=Pending, 2=Open...
    const status = parseStatus(p.status);
    const cause  = (status === "Closed" || status === "Liquidated") ? parseCloseCause(p.cause) : "";
    console.log(status);
    const statusCell = status + (cause ? " / " + cause : "");

    // Common fields we still want to show
    const collateralUnderlying6 = BigInt(p.collateral ?? 0);
    const collateral = Number(collateralUnderlying6) / 1e6;

    // SIZE (owner-decrypted) — needed even pre-open
    let sizeUnderlying6 = 0n;
    let sizeStr = "—";
    try {
      const sizeDec = await cofhejs.unseal(p.size, FheTypes.Uint256);
      if (sizeDec.success) {
        sizeUnderlying6 = BigInt(sizeDec.data);
        sizeStr = "$" + fmtUSD6(sizeUnderlying6);
      }
    } catch {}

    // side (for POSITION label)
    let isLong = false;
    try { isLong = await decryptBool(p.isLong); } catch {}

    // leverage display (ok to show pre-open)
    let levStr = "—";
    if (sizeUnderlying6 > 0n && collateral > 0) {
      const lev = (Number(sizeUnderlying6) / 1e6) / collateral;
      levStr = (lev >= 100 ? lev.toFixed(0) : lev.toFixed(2)) + "x";
    }

    // position cell (single line)
    const positionCell = `${market} • ${levStr} ${isLong ? "Long" : "Short"}`;

    // --- If PRE-OPEN: only show Position/Size/Collateral/Status; everything else '—' ---
    if (isPreOpen) {
      console.log(
        col(positionCell, 28) +
        col(sizeStr,      16) +
        col("—",          16) +   // EQUITY
        col("$" + usd(collateral, 2), 16) +
        col("—",          16) +   // PNL
        col("—",          16) +   // ENTRY PRICE
        col("—",          16) +   // LIQ. PRICE
        col("—",          16) +   // SETTLED PRICE
        col(statusCell,   28)
      );
      continue; // skip heavy calcs when < Open
    }

    // --- Post-OPEN calculations
    const entry = toNumE8(BigInt(p.entryPrice ?? 0));

    // NET VALUE from pendingEquity.equityNet (X18)
    let netValueUnderlying6 = 0n;
    let netValueStr = "—";
    try {
      const peq = await getPendingEquity(signer.address, id);
      const eqDec = await cofhejs.unseal(peq.equityNet, FheTypes.Uint256); // X18
      if (eqDec.success) {
        netValueUnderlying6 = div1e18(eqDec.data);
        netValueStr = "$" + fmtUSD6(netValueUnderlying6);
      }
    } catch {}

    // PnL = NetValue − Collateral  (display only)
    let pnlStr = "—";
    if (netValueUnderlying6 > 0n) {
      const pnl = netValueUnderlying6 - collateralUnderlying6;
      pnlStr = fmtPnl(pnl);
    }

    // liq price (approx)
    let liqStr = "—";
    if (sizeUnderlying6 > 0n && entry > 0 && mmBps > 0) {
      const S = Number(sizeUnderlying6) / 1e6;
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

    console.log(
      col(positionCell, 28) +
      col(sizeStr,      16) +
      col(netValueStr,  16) +
      col("$" + usd(collateral, 2), 16) +
      col(pnlStr,       16) +
      col("$" + usd(entry, 2),     16) +
      col(liqStr,       16) +
      col(settledPx > 0 ? ("$" + usd(settledPx, 2)) : "—", 16) +
      col(statusCell,   28)
    );
  }
}
