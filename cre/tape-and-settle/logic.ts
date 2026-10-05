/**
 * Pure decision logic for the tape-and-settle workflow. No SDK, no I/O: unit-tested with `bun test`.
 * Prices are bigint in the market's own decimals; returns are basis points truncated toward zero, exactly like
 * SettlerV2 on chain (BigInt division truncates toward zero like Solidity).
 */
export const LONG = 1;
export const SHORT = 2;
export const REVEALED = 2;

export type CallInfo = {
  id: bigint;
  status: number;
  perpId: number;
  direction: number;
  tpBps: number;
  slBps: number;
  entryPNS: bigint;
  entryOracleTs: bigint;
  horizonEnd: bigint;
  priceDecimals: number;
};
export type Oracle = { price: bigint; ts: bigint; decimals: number };
export type TapeHead = { count: bigint; lastTs: bigint; lastPrice: bigint };
export type TapeSample = { index: bigint; ts: bigint; price: bigint };

export function returnBps(c: CallInfo, price: bigint): bigint {
  const raw = ((price - c.entryPNS) * 10_000n) / c.entryPNS;
  return c.direction === SHORT ? -raw : raw;
}

/** +tp / -sl when the price touches a bound, else null. */
export function touchScore(c: CallInfo, price: bigint): bigint | null {
  const r = returnBps(c, price);
  if (r >= BigInt(c.tpBps)) return BigInt(c.tpBps);
  if (r <= -BigInt(c.slBps)) return -BigInt(c.slBps);
  return null;
}

export function clampedReturn(c: CallInfo, price: bigint): bigint {
  const r = returnBps(c, price);
  const lo = -BigInt(c.slBps);
  const hi = BigInt(c.tpBps);
  return r < lo ? lo : r > hi ? hi : r;
}

/**
 * Which markets need a tape sample RIGHT NOW. Gas is the scarce resource (Monad charges the gas limit), so the tape is
 * written on demand instead of continuously:
 *  - tripwire: while a revealed call is running, the live oracle touches its TP/SL and the tape's latest sample does not
 *  - endpoint: a call is past its horizon, the tape has no sample at/after the horizon yet, and the oracle has one
 */
export function planSampling(
  calls: CallInfo[],
  oracles: Map<number, Oracle>,
  heads: Map<number, TapeHead>,
  now: bigint,
): { perpIds: number[]; reasons: string[] } {
  const perps = new Set<number>();
  const reasons: string[] = [];
  for (const c of calls) {
    if (c.status !== REVEALED) continue;
    const o = oracles.get(c.perpId);
    const h = heads.get(c.perpId) ?? { count: 0n, lastTs: 0n, lastPrice: 0n };
    if (!o || o.decimals !== c.priceDecimals) continue;
    if (now < c.horizonEnd) {
      const fresh = o.ts > h.lastTs && o.ts > c.entryOracleTs;
      const tapeAlreadyShowsTouch = h.count > 0n && h.lastTs > c.entryOracleTs && touchScore(c, h.lastPrice) !== null;
      if (fresh && touchScore(c, o.price) !== null && !tapeAlreadyShowsTouch) {
        perps.add(c.perpId);
        reasons.push(`call ${c.id}: oracle touches TP/SL`);
      }
    } else if (h.lastTs < c.horizonEnd && o.ts >= c.horizonEnd) {
      perps.add(c.perpId);
      reasons.push(`call ${c.id}: endpoint sample needed`);
    }
  }
  return { perpIds: [...perps], reasons };
}

/**
 * The deciding sample for a call that is past its horizon: the first path sample (entry < ts < horizonEnd) that touches
 * TP/SL, else the endpoint (first sample at/after the horizon) scored by its clamped return. `path` must be in tape order.
 */
export function pickProposal(
  c: CallInfo,
  path: TapeSample[],
  endpoint: TapeSample,
): { index: bigint; touch: boolean; score: bigint } {
  for (const s of path) {
    if (s.ts <= c.entryOracleTs || s.ts >= c.horizonEnd) continue;
    const t = touchScore(c, s.price);
    if (t !== null) return { index: s.index, touch: true, score: t };
  }
  return { index: endpoint.index, touch: false, score: clampedReturn(c, endpoint.price) };
}
