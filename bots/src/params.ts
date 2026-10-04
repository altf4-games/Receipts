import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * The bots are STATELESS. A call's secret salt is derived from a master secret plus public on-chain facts, and the
 * call's parameters can only be one of a small discrete set. So a keeper that has only the master secret can recover
 * exactly what was committed (by testing the candidates against the on-chain hash) and reveal it, even after a
 * restart or on a different machine. No database to lose.
 */
export const DIRS = [1, 2] as const; // 1 = long, 2 = short (matches CallRegistry)
export const TP_SET = [50, 100, 150, 200, 300] as const; // bps
export const SL_SET = [50, 75, 100, 150, 200] as const; // bps

export type Direction = 1 | 2;

export function nearest<T extends number>(set: readonly T[], target: number): T {
  let best = set[0];
  for (const v of set) if (Math.abs(v - target) < Math.abs(best - target)) best = v;
  return best;
}

/** Per-bot secret: keccak(master, handle). */
export function botSecret(master: Hex, handle: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [master, handle]));
}

/** Horizon carries a small time-derived offset so a salt is not reused across calls (up to 10 min of jitter). */
export function jitteredHorizon(baseSecs: number, nowSec: bigint, jitterMod = 600): number {
  return baseSecs + Number((nowSec / 60n) % BigInt(jitterMod));
}

export function deriveSalt(secret: Hex, perpId: bigint, horizonSecs: number): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint32" }], [secret, perpId, horizonSecs]),
  );
}

/** keccak256(abi.encode(chainid, registry, curator, perpId, direction, tp, sl, horizonSecs, salt)): same as CallRegistry.hashCall */
export function callHash(a: {
  chainId: number; registry: Address; curator: Address; perpId: bigint;
  direction: number; tpBps: number; slBps: number; horizonSecs: number; salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [BigInt(a.chainId), a.registry, a.curator, a.perpId, a.direction, a.tpBps, a.slBps, a.horizonSecs, a.salt],
    ),
  );
}

export interface Recovered { direction: Direction; tpBps: number; slBps: number; salt: Hex }

/** Find the committed parameters by testing every candidate against the on-chain hash. null = not ours / lost secret. */
export function recoverParams(a: {
  chainId: number; registry: Address; curator: Address; perpId: bigint; horizonSecs: number;
  secret: Hex; onchainHash: Hex;
}): Recovered | null {
  const salt = deriveSalt(a.secret, a.perpId, a.horizonSecs);
  for (const direction of DIRS) for (const tpBps of TP_SET) for (const slBps of SL_SET) {
    const h = callHash({ chainId: a.chainId, registry: a.registry, curator: a.curator, perpId: a.perpId, direction, tpBps, slBps, horizonSecs: a.horizonSecs, salt });
    if (h.toLowerCase() === a.onchainHash.toLowerCase()) return { direction, tpBps, slBps, salt };
  }
  return null;
}

/** Deterministic commit window per (bot, market): no state needed to know "is it time to commit". */
export function inCommitWindow(handle: string, perpId: bigint, nowSec: bigint, periodSecs: number, windowSecs: number): boolean {
  const offset = BigInt(
    keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [handle, perpId])).slice(0, 12),
  ) % BigInt(periodSecs);
  const phase = (nowSec + BigInt(periodSecs) - offset) % BigInt(periodSecs);
  return phase < BigInt(windowSecs);
}
