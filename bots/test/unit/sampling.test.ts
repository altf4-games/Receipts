import { describe, expect, test } from "vitest";
import type { Address } from "viem";
import { PATH_MIN_KEEPER_BALANCE_WEI, PATH_SAMPLE_GAP_SECS, planPathSamples, samplePath } from "../../src/sampling.js";

const NOW = 1_800_000_000;

describe("planPathSamples", () => {
  test("a market that was never sampled needs one", () => {
    expect(planPathSamples([48], {}, NOW)).toEqual([48]);
    expect(planPathSamples([48], { 48: null }, NOW)).toEqual([48]);
  });
  test("a fresh sample is not repeated; one at exactly the gap is", () => {
    expect(planPathSamples([16], { 16: NOW - PATH_SAMPLE_GAP_SECS + 1 }, NOW)).toEqual([]);
    expect(planPathSamples([16], { 16: NOW - PATH_SAMPLE_GAP_SECS }, NOW)).toEqual([16]);
  });
  test("markets are de-duplicated and sorted, and only stale ones are returned", () => {
    expect(planPathSamples([64, 16, 16, 48], { 16: NOW - 5, 48: NOW - 2000, 64: NOW - 901 }, NOW)).toEqual([48, 64]);
  });
});

function fakeCtx(opts: { counts: Record<number, bigint>; lastTs: Record<number, bigint>; failCount?: boolean }) {
  const sent: { fn: string; args: unknown[] }[] = [];
  const logs: Record<string, unknown>[] = [];
  const ctx = {
    deployment: { priceTape: "0x050e4F35D946BF83AcD7C1D60c9512D308c078fA" as Address },
    nowSec: () => BigInt(NOW),
    log: (e: Record<string, unknown>) => logs.push(e),
    pc: {
      multicall: async (a: { contracts: { functionName: string; args: [bigint, bigint?] }[] }) =>
        a.contracts.map((c) => {
          if (opts.failCount) return { status: "failure" };
          const p = Number(c.args[0]);
          if (c.functionName === "sampleCount") return { status: "success", result: opts.counts[p] ?? 0n };
          return { status: "success", result: { ts: opts.lastTs[p] ?? 0n, price: 1n } };
        }),
    },
  };
  const send = async (_c: unknown, _a: unknown, _abi: unknown, fn: string, args: unknown[]) => { sent.push({ fn, args }); return { hash: "0x1" as never, ok: true }; };
  return { ctx: ctx as never, sent, logs, send: send as never };
}

describe("samplePath", () => {
  const ok = PATH_MIN_KEEPER_BALANCE_WEI;
  test("records ONE transaction for every open market that is stale", async () => {
    const f = fakeCtx({ counts: { 16: 5n, 32: 5n, 48: 0n }, lastTs: { 16: BigInt(NOW - 100), 32: BigInt(NOW - 1000) } });
    await samplePath(f.ctx, [16, 32, 48], ok, f.send, () => true);
    expect(f.sent).toEqual([{ fn: "sample", args: [[32n, 48n]] }]); // 16 is fresh, 32 stale, 48 never sampled
  });
  test("sends nothing when every market is fresh", async () => {
    const f = fakeCtx({ counts: { 16: 2n }, lastTs: { 16: BigInt(NOW - 10) } });
    await samplePath(f.ctx, [16], ok, f.send, () => true);
    expect(f.sent).toEqual([]);
  });
  test("does not spend when the keeper balance is low, and says so", async () => {
    const f = fakeCtx({ counts: {}, lastTs: {} });
    await samplePath(f.ctx, [16], ok - 1n, f.send, () => true);
    expect(f.sent).toEqual([]);
    expect(f.logs.some((l) => l.evt === "path_sample_skipped_low_balance")).toBe(true);
  });
  test("does nothing without a transaction budget or open markets", async () => {
    const f = fakeCtx({ counts: {}, lastTs: {} });
    await samplePath(f.ctx, [16], ok, f.send, () => false);
    await samplePath(f.ctx, [], ok, f.send, () => true);
    expect(f.sent).toEqual([]);
  });
  test("an unreadable tape is never guessed: no transaction", async () => {
    const f = fakeCtx({ counts: {}, lastTs: {}, failCount: true });
    await samplePath(f.ctx, [16], ok, f.send, () => true);
    expect(f.sent).toEqual([]);
  });
});
