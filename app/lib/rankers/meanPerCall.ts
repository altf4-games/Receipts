import { order } from "./rank";
import { closedScores, type CuratorInput, type Ranked, type Ranker } from "./types";

/** Average score per closed call. Fair across volumes but fooled by a short lucky streak (9 wins in 10 calls). */
export const meanPerCall: Ranker = {
  name: "mean-per-call",
  description: "Average score per closed call (bps), no confidence adjustment: it does not reward volume, but a short hot streak tops it.",
  minCalls: 1,
  rank(curators: CuratorInput[]): Ranked[] {
    return order(
      curators.map((c) => {
        const s = closedScores(c);
        const m = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
        return { id: c.id, handle: c.handle, isBot: c.isBot, score: s.length ? m : null, n: s.length, detail: { mean: m } as Record<string, number> };
      }),
    );
  },
};
