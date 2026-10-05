/** Prints the coin-flip simulation table used in the docs:  pnpm exec tsx scripts/coinflip.ts */
import { luckAdjusted, meanPerCall, raw } from "../src/index.js";
import { DEFAULT_SIM, simulate } from "../src/coinflipSim.js";

const rankers = [raw, meanPerCall, luckAdjusted(10)];
for (const [label, params] of [
  ["A: weak edge (win rate 58%, 60 calls)", DEFAULT_SIM],
  ["B: clear edge (win rate 65%, 100 calls)", { ...DEFAULT_SIM, skillP: 0.65, skilledCalls: 100 }],
] as const) {
  const r = simulate(rankers, params);
  console.log(`\n${label}: ${params.coinFlippers} coin flippers with ${params.minCoinCalls}-${params.maxCoinCalls} calls each, ${params.skilled} skilled, ${r.trials} trials`);
  for (const k of Object.keys(r.topIsSkilled)) console.log(`  ${k.padEnd(14)} #1 is skilled: ${(r.topIsSkilled[k]! * 100).toFixed(1)}%   skilled in top 3: ${r.skilledInTop3[k]!.toFixed(2)} of ${params.skilled}`);
}
