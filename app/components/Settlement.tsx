import { TAPE } from "@/lib/config";
import type { CallView } from "@/lib/calls";
import { DisputeActions } from "./DisputeActions";
import type { TapeView } from "@/lib/tape";

const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
const W = 320, H = 120, PAD = 6, PT = 16, PB = 16; // top/bottom padding leaves room for the labels

/** Price tape sparkline with the call's entry, take-profit and stop-loss levels, and how the call was (or will be) settled. */
export function Settlement({ c, tape }: { c: CallView; tape: TapeView | null }) {
  const byTape = (c.flags & 4) !== 0;
  const entry = Number(c.entryPrice);
  const dir = c.direction;
  const tp = dir && c.tpBps !== null ? entry * (1 + (dir === "LONG" ? 1 : -1) * c.tpBps / 1e4) : null;
  const sl = dir && c.slBps !== null ? entry * (1 + (dir === "LONG" ? -1 : 1) * c.slBps / 1e4) : null;
  const pts = tape?.points ?? [];

  let chart: React.ReactNode = null;
  if (pts.length >= 2) {
    const ys = [entry, ...pts.map((p) => p.price), ...(tp ? [tp] : []), ...(sl ? [sl] : [])];
    const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
    const t0 = Math.min(c.commitTime, pts[0].ts), t1 = Math.max(...pts.map((p) => p.ts), c.horizonEnd), ts = t1 - t0 || 1;
    const x = (t: number) => PAD + ((t - t0) / ts) * (W - 2 * PAD);
    const y = (v: number) => H - PB - ((v - lo) / span) * (H - PT - PB);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
    const rule = (v: number, col: string, label: string) => (
      <g key={label}><line x1={PAD} x2={W - PAD} y1={y(v)} y2={y(v)} stroke={col} strokeDasharray="3 3" strokeWidth="1" /><text x={PAD + 2} y={y(v) - 3} fontSize="8" fill={col}>{label}</text></g>
    );
    chart = (
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label={`Price tape: ${pts.length} oracle samples between the commit and the end of the window, with entry, take-profit and stop-loss levels`}>
        {rule(entry, "var(--paper-dim)", "entry")}
        {tp && rule(tp, "var(--stamp-green)", "TP")}
        {sl && rule(sl, "var(--stamp-red)", "SL")}
        <line x1={x(c.horizonEnd)} x2={x(c.horizonEnd)} y1={PT - 4} y2={H - PB + 4} stroke="var(--rule)" strokeWidth="1" />
        <text x={x(c.horizonEnd) - 2} y={H - 4} fontSize="8" textAnchor="end" fill="var(--paper-dim)">horizon</text>
        <path d={line} fill="none" stroke="var(--paper-ink)" strokeWidth="1.5" />
        {pts.map((p, i) => <circle key={i} cx={x(p.ts)} cy={y(p.price)} r="2" fill="var(--paper-ink)" />)}
      </svg>
    );
  }

  const prop = tape?.proposal ?? null;
  // earliest sample before the proposal that already touched TP or SL: the one a challenger would point at
  const touches = (price: number) => !!dir && ((dir === "LONG" && ((tp !== null && price >= tp) || (sl !== null && price <= sl))) || (dir === "SHORT" && ((tp !== null && price <= tp) || (sl !== null && price >= sl))));
  const candidate = prop ? pts.find((p) => p.index < prop.index && p.ts >= c.entryOracleTs && p.ts < c.horizonEnd && touches(p.price))?.index ?? null : null;
  const windowEnd = prop ? prop.proposedAt + TAPE.disputeWindow : 0;
  return (
    <section className="slip mt-4" aria-label="Settlement">
      <div className="text-sm font-bold">Settlement</div>
      <hr />
      {c.status === "Settled" && byTape && <p className="text-sm">Settled from the on-chain price tape (SettlerV2), after a {TAPE.disputeWindow / 60} minute dispute window. The tape is sampled from Perpl&apos;s Chainlink-fed oracle inside the transaction that records it, so a settler cannot hand it a price.</p>}
      {c.status === "Settled" && !byTape && <p className="text-sm">Settled by SettlerV1 from the oracle price at the horizon (endpoint scoring, no path data). Calls settled after the tape went live are scored by the tape instead.</p>}
      {c.status === "Revealed" && !prop && <p className="text-sm">Revealed. After the horizon, the tape is sampled and the first take-profit or stop-loss touch (or the endpoint) is proposed on chain, then finalised after the dispute window.</p>}
      {c.status === "Revealed" && prop && (
        <p className="text-sm">
          Proposed {prop.touch ? "from a TP/SL touch" : "from the endpoint"} at tape sample #{prop.index}: {pct(prop.scoreBps)}.{" "}
          {prop.finalized ? "Finalised." : prop.disputed ? "Disputed once, new proposal stands." : `Anyone can dispute with an earlier sample until ${new Date(windowEnd * 1000).toISOString().slice(11, 19)}Z.`}
        </p>
      )}
      {c.status === "Revealed" && prop && <DisputeActions callId={c.id} windowEnd={windowEnd} finalized={prop.finalized} candidate={candidate} />}
      {c.status === "Sealed" && <p className="text-sm">Sealed. The call is hidden until the curator reveals it, so TP/SL levels are not shown yet. An unrevealed call expires at -30.00%.</p>}
      {(c.status === "Expired" || c.status === "Invalid") && <p className="text-sm">No settlement: the call was never validly revealed, so it carries the fixed penalty.</p>}
      {chart}
      {tape && (tape.totalInWindow > 0 || c.status === "Revealed") && <div className="mt-1 text-[10px] dim">{tape.totalInWindow} tape sample{tape.totalInWindow === 1 ? "" : "s"} for this market since the commit (oracle timestamps, UTC). The keeper records about one sample every 15 minutes while a call is open (each costs gas), so a TP/SL touch is resolved to about that resolution.</div>}
      {!tape && c.status !== "Sealed" && c.status !== "Settled" && <div className="mt-1 text-[10px] dim">No tape for this deployment.</div>}
    </section>
  );
}
