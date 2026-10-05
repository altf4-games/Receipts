import { order } from "./rank.js";
import { closedScores, type CuratorInput, type Ranked, type Ranker } from "./types.js";
import { DEFAULT_MIN_CALLS, Z_95 } from "./luckAdjusted.js";

/** Wilson score interval lower bound for a proportion wins / n (z = 1.645). */
export function wilsonLower(wins: number, n: number, z = Z_95): number {
  if (n === 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/** Hit rate with a Wilson lower bound: wins are calls with a positive score; expired / invalid calls are losses. */
export function wilson(minCalls = DEFAULT_MIN_CALLS): Ranker {
  return {
    name: "hit-rate-wilson",
    description: `Lower 95% Wilson bound of the share of calls that scored above zero. Unrevealed and invalid calls are losses. Needs at least ${minCalls} closed calls.`,
    minCalls,
    rank(curators: CuratorInput[]): Ranked[] {
      return order(
        curators.map((c) => {
          const s = closedScores(c);
          const wins = s.filter((x) => x > 0).length;
          const n = s.length;
          return { id: c.id, handle: c.handle, isBot: c.isBot, score: n >= minCalls ? wilsonLower(wins, n) : null, n, detail: { wins, rate: n ? wins / n : 0 } };
        }),
      );
    },
  };
}
