import { order } from "./rank.js";
import { closedScores, type CuratorInput, type Ranked, type Ranker } from "./types.js";

/** One-sided 95% normal quantile. */
export const Z_95 = 1.645;
/** Floor for the standard deviation, in bps: a curator with a handful of near-identical calls must not get a zero-width bound. */
export const MIN_SD_BPS = 10;
export const DEFAULT_MIN_CALLS = 10;

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n - 1). */
export function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Lower confidence bound of the mean score per call: mean - z * sd / sqrt(n).
 * A lucky streak over few calls has a wide interval and a low bound; the same average over many calls has a tight one.
 * Curators below `minCalls` closed calls are unranked. Unrevealed calls count at -3000 bps, so hiding is never free.
 */
export function luckAdjusted(minCalls = DEFAULT_MIN_CALLS): Ranker {
  return {
    name: "luck-adjusted",
    description: `Lower 95% confidence bound of the mean score per call (mean - 1.645 * sd / sqrt(n), sd floored at ${MIN_SD_BPS} bps). Needs at least ${minCalls} closed calls. A short lucky streak ranks below a long solid record.`,
    minCalls,
    rank(curators: CuratorInput[]): Ranked[] {
      return order(
        curators.map((c) => {
          const s = closedScores(c);
          const n = s.length;
          if (n < minCalls) {
            const detail: Record<string, number> = { mean: n ? mean(s) : 0, needMore: minCalls - n };
            return { id: c.id, handle: c.handle, isBot: c.isBot, score: null, n, detail };
          }
          const m = mean(s);
          const sd = Math.max(sampleSd(s), MIN_SD_BPS);
          const bound = m - (Z_95 * sd) / Math.sqrt(n);
          const detail: Record<string, number> = { mean: m, sd, bound };
          return { id: c.id, handle: c.handle, isBot: c.isBot, score: bound, n, detail };
        }),
      );
    },
  };
}
