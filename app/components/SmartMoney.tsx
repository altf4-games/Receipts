import type { SmContext } from "@/lib/smartMoneyView";

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`);
const asOf = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";

/** What Nansen's Smart Money was doing in this market in the 24 h before the call was sealed. */
export function SmartMoney({ sm, symbol, direction }: { sm: SmContext; symbol: string; direction: "LONG" | "SHORT" | null }) {
  if (!direction) return null; // the direction of a sealed call is secret: no comparison until it is revealed
  return (
    <section className="slip mt-4 text-sm" aria-label="Smart money at commit">
      <div className="font-bold">Smart money at commit <span className="text-xs font-normal dim">· Nansen</span></div>
      <hr />
      {!sm || sm.lean.lean === "NO_DATA" ? (
        <p className="dim">{!sm ? "No Nansen snapshot stored yet." : `Not enough Smart Money ${symbol} activity stored for the 24 h before this call (${sm.lean.trades} new positions; Nansen only serves the trailing 7 days, and I only started storing it on Oct 5).`}</p>
      ) : (
        <>
          <p>
            Smart Money opened {usd(sm.lean.longUsd)} long and {usd(sm.lean.shortUsd)} short {symbol} in the 24 h before this call
            ({sm.lean.trades} new positions): lean <b>{sm.lean.lean}</b>.{" "}
            This call is <b>{sm.align === "with" ? `with it (${direction})` : sm.align === "against" ? `against it (${direction})` : `${direction}, with no clear lean to compare`}</b>.
          </p>
          <p className="mt-2 text-xs dim">Nansen Smart Money perp trades cover Hyperliquid, not Perpl, so this is the wider smart-money mood, not Perpl flow. Snapshot as of {asOf(sm.fetchedAt)}; only trades before the commit time are counted.</p>
        </>
      )}
    </section>
  );
}
