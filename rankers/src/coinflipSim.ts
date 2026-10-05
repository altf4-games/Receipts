import type { CuratorInput, Ranker } from "./types.js";

/**
 * A STYLISED simulation, not data: it shows what a ranking rule rewards when some curators are pure coin flips and a few
 * have a small real edge. Scores are +TP / -SL = +100 / -100 bps; a coin flip wins with p = 0.5, a skilled curator with
 * `skillP`. Deterministic (seeded PRNG), so the numbers in the docs are reproducible with `pnpm tsx scripts/coinflip.ts`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimParams {
  coinFlippers: number;
  skilled: number;
  skillP: number;
  skilledCalls: number;
  minCoinCalls: number;
  maxCoinCalls: number;
  trials: number;
  seed: number;
}

export const DEFAULT_SIM: SimParams = { coinFlippers: 30, skilled: 3, skillP: 0.58, skilledCalls: 60, minCoinCalls: 10, maxCoinCalls: 120, trials: 1000, seed: 20261005 };

function makeCurator(id: string, handle: string, calls: number, p: number, rnd: () => number): CuratorInput {
  return {
    id, handle, isBot: false,
    calls: Array.from({ length: calls }, (_, i) => ({ callId: i, perpId: 16, status: "SETTLED" as const, scoreBps: rnd() < p ? 100 : -100 })),
  };
}

export interface SimResult {
  trials: number;
  /** share of trials in which the #1 curator under the ranker is one of the skilled curators */
  topIsSkilled: Record<string, number>;
  /** mean number of skilled curators among the top 3 */
  skilledInTop3: Record<string, number>;
}

export function simulate(rankers: Ranker[], p: SimParams = DEFAULT_SIM): SimResult {
  const rnd = mulberry32(p.seed);
  const top: Record<string, number> = {};
  const top3: Record<string, number> = {};
  for (const r of rankers) { top[r.name] = 0; top3[r.name] = 0; }
  for (let t = 0; t < p.trials; t++) {
    const curators: CuratorInput[] = [];
    for (let i = 0; i < p.coinFlippers; i++) {
      const n = p.minCoinCalls + Math.floor(rnd() * (p.maxCoinCalls - p.minCoinCalls + 1));
      curators.push(makeCurator(`c${i}`, `coin-${i}`, n, 0.5, rnd));
    }
    for (let i = 0; i < p.skilled; i++) curators.push(makeCurator(`s${i}`, `skilled-${i}`, p.skilledCalls, p.skillP, rnd));
    for (const r of rankers) {
      const ranked = r.rank(curators).filter((x) => x.rank !== null);
      if (ranked[0]?.id.startsWith("s")) top[r.name]!++;
      top3[r.name]! += ranked.slice(0, 3).filter((x) => x.id.startsWith("s")).length;
    }
  }
  const topIsSkilled: Record<string, number> = {};
  const skilledInTop3: Record<string, number> = {};
  for (const r of rankers) { topIsSkilled[r.name] = top[r.name]! / p.trials; skilledInTop3[r.name] = top3[r.name]! / p.trials; }
  return { trials: p.trials, topIsSkilled, skilledInTop3 };
}
