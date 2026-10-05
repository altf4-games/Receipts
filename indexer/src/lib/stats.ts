/**
 * Pure scoring bookkeeping for the CuratorStats / MarketStats entities. No indexer imports so it is unit-tested alone.
 * Scores are basis points (bps) exactly as the CallRegistry stores them; the unrevealed penalty is -3000 bps.
 */
export const UNREVEALED_PENALTY_BPS = -3000;
export const FLAG_PATH_TAPE = 4;
export const FLAG_DISPUTED = 8;

export type CloseKind = "settled" | "expired" | "invalid";

export interface CuratorStatsData {
  calls: number;
  settled: number;
  expired: number;
  invalid: number;
  wins: number;
  losses: number;
  sumScoreBps: number;
  sumSqScoreBps: bigint;
  bestBps: number;
  worstBps: number;
  equityBps: number;
  peakEquityBps: number;
  maxDrawdownBps: number;
  firstCommitTime: number;
  lastCloseTime: number;
}

export const emptyStats = (firstCommitTime = 0): CuratorStatsData => ({
  calls: 0, settled: 0, expired: 0, invalid: 0, wins: 0, losses: 0, sumScoreBps: 0, sumSqScoreBps: 0n,
  bestBps: 0, worstBps: 0, equityBps: 0, peakEquityBps: 0, maxDrawdownBps: 0, firstCommitTime, lastCloseTime: 0,
});

/** A closed call (settled, expired or invalid) moves the running scoreboard. Closes must be applied in chain order. */
export function applyClose(s: CuratorStatsData, kind: CloseKind, scoreBps: number, time: number): CuratorStatsData {
  const closed = s.settled + s.expired + s.invalid;
  const equity = s.equityBps + scoreBps;
  const peak = Math.max(s.peakEquityBps, equity);
  return {
    ...s,
    settled: s.settled + (kind === "settled" ? 1 : 0),
    expired: s.expired + (kind === "expired" ? 1 : 0),
    invalid: s.invalid + (kind === "invalid" ? 1 : 0),
    wins: s.wins + (scoreBps > 0 ? 1 : 0),
    losses: s.losses + (scoreBps < 0 ? 1 : 0),
    sumScoreBps: s.sumScoreBps + scoreBps,
    sumSqScoreBps: s.sumSqScoreBps + BigInt(scoreBps) * BigInt(scoreBps),
    bestBps: closed === 0 ? scoreBps : Math.max(s.bestBps, scoreBps),
    worstBps: closed === 0 ? scoreBps : Math.min(s.worstBps, scoreBps),
    equityBps: equity,
    peakEquityBps: peak,
    maxDrawdownBps: Math.max(s.maxDrawdownBps, peak - equity),
    lastCloseTime: time,
  };
}

/** Perpl market scaling (verified against /api/v1/pub/context on 2026-10-05): [priceDecimals, sizeDecimals]. */
export const PERPL_MARKET_DECIMALS: Record<number, Record<number, [number, number]>> = {
  10143: { 16: [1, 5], 32: [2, 3], 48: [2, 3], 64: [5, 0], 256: [3, 3], 272: [5, 1], 320: [6, 0], 336: [4, 2] },
  143: { 1: [1, 5], 10: [6, 0], 20: [2, 3], 31: [3, 3], 40: [4, 2], 50: [2, 4], 60: [5, 1], 70: [4, 2], 90: [6, 0], 100: [4, 2], 110: [4, 2] },
};

/** notional of lot x price in AUSD micro-units (6 decimals); 0 for a market we have no scaling for (never guessed). */
export function notionalMicroUsd(chainId: number, perpId: number, lotLNS: bigint, pricePNS: bigint): bigint {
  const dec = PERPL_MARKET_DECIMALS[chainId]?.[perpId];
  if (!dec) return 0n;
  const [pd, sd] = dec;
  return (lotLNS * pricePNS * 1_000_000n) / 10n ** BigInt(pd + sd);
}

export const unixDay = (ts: number) => Math.floor(ts / 86400);
