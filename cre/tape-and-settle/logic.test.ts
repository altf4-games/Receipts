import { describe, expect, test } from "bun:test";
import { LONG, REVEALED, SHORT, clampedReturn, pickProposal, planSampling, returnBps, touchScore, type CallInfo, type Oracle, type TapeHead } from "./logic";

const ENTRY = 849_810n;
const call = (over: Partial<CallInfo> = {}): CallInfo => ({
  id: 1n, status: REVEALED, perpId: 16, direction: LONG, tpBps: 100, slBps: 100, entryPNS: ENTRY, entryOracleTs: 1_000n, horizonEnd: 4_600n, priceDecimals: 1, ...over,
});
const oracles = (price: bigint, ts: bigint, decimals = 1) => new Map<number, Oracle>([[16, { price, ts, decimals }]]);
const heads = (count: bigint, lastTs: bigint, lastPrice: bigint) => new Map<number, TapeHead>([[16, { count, lastTs, lastPrice }]]);

describe("returns match SettlerV2 arithmetic", () => {
  test("truncates toward zero on both signs and flips for shorts", () => {
    expect(returnBps(call(), 849_811n)).toBe(0n);
    expect(returnBps(call(), 849_809n)).toBe(0n);
    expect(returnBps(call({ direction: SHORT }), 839_810n)).toBe(117n);
    expect(returnBps(call({ direction: SHORT }), 850_660n)).toBe(-10n);
  });
  test("touch boundaries are inclusive and exact", () => {
    expect(touchScore(call(), 858_309n)).toBe(100n); // exactly +100
    expect(touchScore(call(), 858_307n)).toBeNull(); // 99
    expect(touchScore(call(), 841_311n)).toBe(-100n); // exactly -100
    expect(touchScore(call({ direction: SHORT }), 840_000n)).toBe(100n);
  });
  test("clamp stays inside the call's own bounds", () => {
    expect(clampedReturn(call(), 1_000_000n)).toBe(100n);
    expect(clampedReturn(call(), 100_000n)).toBe(-100n);
    expect(clampedReturn(call(), 850_660n)).toBe(10n);
  });
});

describe("planSampling (gas is scarce: sample on demand)", () => {
  test("nothing to do when no revealed call exists or the call is not running yet", () => {
    expect(planSampling([], oracles(ENTRY, 2_000n), heads(0n, 0n, 0n), 2_000n).perpIds).toEqual([]);
    expect(planSampling([call({ status: 1 })], oracles(900_000n, 2_000n), heads(0n, 0n, 0n), 2_000n).perpIds).toEqual([]);
  });
  test("tripwire fires when the live oracle touches and the tape does not yet show a touch", () => {
    const p = planSampling([call()], oracles(858_400n, 2_000n), heads(1n, 1_500n, 850_000n), 2_000n);
    expect(p.perpIds).toEqual([16]);
  });
  test("no tripwire when the oracle does not touch, is not newer than the tape, or the tape already shows the touch", () => {
    expect(planSampling([call()], oracles(850_000n, 2_000n), heads(1n, 1_500n, 850_000n), 2_000n).perpIds).toEqual([]);
    expect(planSampling([call()], oracles(858_400n, 1_500n), heads(1n, 1_500n, 850_000n), 2_000n).perpIds).toEqual([]);
    expect(planSampling([call()], oracles(859_000n, 2_000n), heads(1n, 1_500n, 858_400n), 2_000n).perpIds).toEqual([]);
    // a tape sample at/before the entry timestamp is not evidence of a touch
    expect(planSampling([call()], oracles(858_400n, 2_000n), heads(1n, 1_000n, 858_400n), 2_000n).perpIds).toEqual([16]);
  });
  test("endpoint sample requested once the horizon passed, the tape lacks one, and the oracle has one", () => {
    expect(planSampling([call()], oracles(850_000n, 4_700n), heads(1n, 4_000n, 850_000n), 4_700n).perpIds).toEqual([16]);
    // oracle has not ticked past the horizon yet: wait
    expect(planSampling([call()], oracles(850_000n, 4_599n), heads(1n, 4_000n, 850_000n), 4_700n).perpIds).toEqual([]);
    // the tape already has the endpoint
    expect(planSampling([call()], oracles(850_000n, 4_800n), heads(2n, 4_650n, 850_000n), 4_800n).perpIds).toEqual([]);
  });
  test("a decimals change is ignored (the contract would revert anyway)", () => {
    expect(planSampling([call()], oracles(858_400n, 2_000n, 2), heads(0n, 0n, 0n), 2_000n).perpIds).toEqual([]);
  });
  test("several calls on one market produce one sample", () => {
    const p = planSampling([call({ id: 1n }), call({ id: 2n })], oracles(858_400n, 2_000n), heads(0n, 0n, 0n), 2_000n);
    expect(p.perpIds).toEqual([16]);
    expect(p.reasons).toHaveLength(2);
  });
});

describe("pickProposal", () => {
  const endpoint = { index: 5n, ts: 4_650n, price: 853_000n };
  test("the FIRST touching path sample wins over later touches and over the endpoint", () => {
    const path = [
      { index: 1n, ts: 1_500n, price: 850_000n },
      { index: 2n, ts: 2_000n, price: 840_000n }, // SL first
      { index: 3n, ts: 2_500n, price: 880_000n }, // TP later
    ];
    expect(pickProposal(call({ tpBps: 300 }), path, endpoint)).toEqual({ index: 2n, touch: true, score: -100n });
  });
  test("no touch: the endpoint, scored by its clamped return", () => {
    const path = [{ index: 1n, ts: 1_500n, price: 850_000n }];
    expect(pickProposal(call(), path, endpoint)).toEqual({ index: 5n, touch: false, score: 37n });
  });
  test("samples at/before the entry timestamp or at/after the horizon are never path samples", () => {
    const path = [
      { index: 0n, ts: 1_000n, price: 900_000n }, // the entry sample itself
      { index: 4n, ts: 4_600n, price: 900_000n }, // at the horizon: that is the endpoint, not the path
    ];
    expect(pickProposal(call(), path, endpoint).touch).toBe(false);
  });
});
