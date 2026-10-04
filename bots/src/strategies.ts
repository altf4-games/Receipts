import { SL_SET, TP_SET, nearest, type Direction } from "./params.js";

/**
 * Simple, openly labelled algorithmic strategies. They exist to create real, scored history on real oracle prices.
 * They are not trading advice and make no claim of edge; coinflip is the explicit no-skill baseline.
 */
export interface Decision { direction: Direction; tpBps: number; slBps: number }

export function ema(values: number[], n: number): number {
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Fast/slow EMA gap in bps of the slow EMA, plus the 1h volatility estimate (bps) from 5-minute returns. */
export function momentumSignal(closes: number[]): { signalBps: number; sigmaHourBps: number } | null {
  if (closes.length < 20) return null;
  const fast = ema(closes, 6);
  const slow = ema(closes, 18);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  return { signalBps: ((fast - slow) / slow) * 10_000, sigmaHourBps: sd * Math.sqrt(12) * 10_000 };
}

const MIN_SIGNAL_BPS = 3; // below this the market is flat: no call

function sizes(sigmaHourBps: number) {
  return { tpBps: nearest(TP_SET, 1.5 * sigmaHourBps), slBps: nearest(SL_SET, 1.0 * sigmaHourBps) };
}

export function momentum(closes: number[]): Decision | null {
  const s = momentumSignal(closes);
  if (!s || Math.abs(s.signalBps) < MIN_SIGNAL_BPS) return null;
  return { direction: (s.signalBps > 0 ? 1 : 2) as Direction, ...sizes(s.sigmaHourBps) };
}

export function contrarian(closes: number[]): Decision | null {
  const d = momentum(closes);
  return d ? { ...d, direction: (d.direction === 1 ? 2 : 1) as Direction } : null;
}

/** Positive funding means longs pay shorts: fade the crowd. `rate` is Perpl's signed fundingRatePct100k. */
export function fundingFade(rate: bigint): Decision | null {
  if (rate === 0n) return null;
  return { direction: (rate > 0n ? 2 : 1) as Direction, tpBps: 100, slBps: 100 };
}

/** The no-skill baseline. `bit` must come from a real random source. */
export function coinflip(bit: 0 | 1): Decision {
  return { direction: (bit === 1 ? 1 : 2) as Direction, tpBps: 100, slBps: 100 };
}
