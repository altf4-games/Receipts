import { order } from "./rank.js";
import { closedScores, type CuratorInput, type Ranked, type Ranker } from "./types.js";

/** Sum of every closed call's score in basis points, unrevealed penalties included. Simple, and easy to win by luck. */
export const raw: Ranker = {
  name: "raw",
  description: "Sum of closed-call scores (bps). Any closed call counts, including the -30% penalty for an unrevealed one. Luck is not corrected for.",
  minCalls: 1,
  rank(curators: CuratorInput[]): Ranked[] {
    return order(
      curators.map((c) => {
        const s = closedScores(c);
        return { id: c.id, handle: c.handle, isBot: c.isBot, score: s.length >= 1 ? s.reduce((a, b) => a + b, 0) : null, n: s.length, detail: { mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0 } };
      }),
    );
  },
};
