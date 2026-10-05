import { order } from "./rank.js";
import type { Ranked } from "./types.js";
import { wilsonLower } from "./wilson.js";

/**
 * "Beats smart money": how a curator's calls line up with Nansen Smart Money positioning at the moment each call was sealed.
 * Pure functions over public data plus a stored snapshot of Nansen's Smart Money perp trades (Hyperliquid, new positions).
 * No clock and no hindsight: only trades up to the commit time are looked at.
 */
export interface SmTrade {
  ts: number; // unix seconds
  symbol: string; // BTC, ETH, SOL
  side: "Long" | "Short";
  valueUsd: number;
}

export type Lean = { lean: "LONG" | "SHORT" | "NEUTRAL" | "NO_DATA"; longUsd: number; shortUsd: number; trades: number };

export const LEAN_WINDOW_SECS = 24 * 3600;
export const LEAN_THRESHOLD = 0.2; // |long - short| / (long + short)
export const LEAN_MIN_TRADES = 3;

/**
 * Net Smart Money lean for a symbol in the window before `commitTs`. NO_DATA when the snapshot does not cover the whole
 * window (`coveredFrom` = oldest second the snapshot is complete for) or when there are too few trades to say anything.
 */
export function leanAt(trades: SmTrade[], symbol: string, commitTs: number, coveredFrom: number, windowSecs = LEAN_WINDOW_SECS): Lean {
  const from = commitTs - windowSecs;
  if (from < coveredFrom) return { lean: "NO_DATA", longUsd: 0, shortUsd: 0, trades: 0 };
  let longUsd = 0, shortUsd = 0, n = 0;
  for (const t of trades) {
    if (t.symbol !== symbol || t.ts < from || t.ts > commitTs) continue;
    n++;
    if (t.side === "Long") longUsd += t.valueUsd; else shortUsd += t.valueUsd;
  }
  const total = longUsd + shortUsd;
  if (n < LEAN_MIN_TRADES || total === 0) return { lean: "NO_DATA", longUsd, shortUsd, trades: n };
  const net = (longUsd - shortUsd) / total;
  return { lean: net > LEAN_THRESHOLD ? "LONG" : net < -LEAN_THRESHOLD ? "SHORT" : "NEUTRAL", longUsd, shortUsd, trades: n };
}

export type Alignment = "with" | "against" | "neutral" | "nodata";

/** direction uses the contract encoding: 1 = LONG, 2 = SHORT. */
export function alignment(direction: number, l: Lean): Alignment {
  if (l.lean === "NO_DATA") return "nodata";
  if (l.lean === "NEUTRAL") return "neutral";
  return (direction === 1) === (l.lean === "LONG") ? "with" : "against";
}

export interface SmCall { status: "SETTLED" | "EXPIRED" | "INVALID" | "REVEALED" | "SEALED"; scoreBps: number | null; alignment: Alignment }
export interface SmCurator { id: string; handle: string; isBot: boolean; calls: SmCall[] }

export const SM_MIN_AGAINST = 3;

/**
 * Ranks curators by the Wilson lower bound of their win rate on calls made AGAINST Smart Money positioning. Following the
 * crowd and being right is cheap; the ranker rewards being right when the smart money leaned the other way. Needs at least
 * SM_MIN_AGAINST settled calls against the lean.
 */
export function beatsSmartMoney(curators: SmCurator[], minAgainst = SM_MIN_AGAINST): Ranked[] {
  return order(
    curators.map((c) => {
      const closed = c.calls.filter((x) => x.status === "SETTLED" && x.scoreBps !== null);
      const against = closed.filter((x) => x.alignment === "against");
      const withSm = closed.filter((x) => x.alignment === "with");
      const wins = against.filter((x) => (x.scoreBps as number) > 0).length;
      const winsWith = withSm.filter((x) => (x.scoreBps as number) > 0).length;
      return {
        id: c.id, handle: c.handle, isBot: c.isBot,
        score: against.length >= minAgainst ? wilsonLower(wins, against.length) : null,
        n: against.length,
        detail: { against: against.length, winsAgainst: wins, with: withSm.length, winsWith, needMore: Math.max(0, minAgainst - against.length) },
      };
    }),
  );
}
