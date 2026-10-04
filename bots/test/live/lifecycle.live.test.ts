/**
 * LIVE: the bots' real tick() against STAGING on Monad testnet. Real txs, real Perpl oracle + candles, real AUSD bonds.
 * Proves the stateless design: every tick builds a FRESH context (new clients, no memory), yet the commit made in one
 * tick is revealed (salt + params recovered from the on-chain hash and the master secret) and settled in later ticks.
 */
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Abi, Address } from "viem";
import callAbi from "../../src/abi/CallRegistry.json" with { type: "json" };
import { buildNodeCtx, repoRoot } from "../../src/node.js";
import { Status, tickAll, type Call } from "../../src/tick.js";
import { SL_SET, TP_SET } from "../../src/params.js";

const LOG = path.join(repoRoot, "docs", "bot-logs", `live-lifecycle-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const events: Record<string, unknown>[] = [];

function fresh() {
  const { ctx, bots } = buildNodeCtx("staging", LOG);
  const inner = ctx.log;
  ctx.log = (e) => { events.push(e); inner(e); };
  ctx.cadence = { periodSecs: 3600, windowSecs: 0 }; // no organic windows during the test
  ctx.opts = { forceCommit: false, horizonBaseOverride: 120, jitterMod: 10 };
  ctx.maxTxPerTick = 3; // production default; the setup tick raises it, the cap test lowers it
  return { ctx, bots };
}

const openIds = async (ctx: ReturnType<typeof fresh>["ctx"], bots: ReturnType<typeof fresh>["bots"]) => {
  // one Multicall3 eth_call for all pairs: the public RPC rate-limits to ~15 calls/s, so a burst of 12 reads fails
  const pairs = bots.flatMap((b) => b.spec.markets.map((perpId) => ({ b, perpId })));
  const res = (await ctx.pc.multicall({
    allowFailure: false,
    contracts: pairs.map(({ b, perpId }) => ({ address: ctx.deployment.callRegistry, abi: callAbi as Abi, functionName: "openCallId", args: [b.address, perpId] })),
  } as never)) as unknown as bigint[];
  return pairs.map(({ b, perpId }, i) => ({ handle: b.spec.handle, perpId, id: res[i], curator: b.address as Address }));
};

describe.sequential("BOTS live lifecycle on staging (stateless ticks)", () => {
  const committed: { handle: string; perpId: bigint; id: bigint }[] = [];

  test("tick 1 (forced): every bot with a signal commits; coinflip always does", async () => {
    const { ctx, bots } = fresh();
    // staging may hold leftovers from an earlier crashed run: resolve them first with normal ticks
    for (let i = 0; i < 40 && (await openIds(ctx, bots)).some((x) => x.id !== 0n); i++) {
      await tickAll(fresh().ctx, bots);
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect((await openIds(ctx, bots)).filter((x) => x.id !== 0n)).toHaveLength(0);

    ctx.opts!.forceCommit = true;
    ctx.maxTxPerTick = 50; // setup only: let every pair commit in this one tick (the cap is tested separately below)
    events.length = 0;
    await tickAll(ctx, bots);
    const commits = events.filter((e) => e.evt === "commit");
    expect(commits.every((e) => e.status === "success")).toBe(true);
    expect(commits.filter((e) => e.bot === "bot:coinflip")).toHaveLength(3);
    expect(events.filter((e) => e.evt === "error")).toHaveLength(0);

    for (const x of await openIds(ctx, bots)) if (x.id !== 0n) committed.push({ handle: x.handle, perpId: x.perpId, id: x.id });
    console.log(`[bots] committed ${committed.length} calls: ${JSON.stringify(committed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    expect(committed.length).toBe(commits.length);
    expect(committed.length).toBeGreaterThanOrEqual(3);
  });

  test("later ticks (fresh context each time) reveal from the recovered salt and settle every call", async () => {
    const deadline = Date.now() + 9 * 60_000;
    let last = fresh();
    while (Date.now() < deadline) {
      last = fresh();
      await tickAll(last.ctx, last.bots);
      if ((await openIds(last.ctx, last.bots)).every((x) => x.id === 0n)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect((await openIds(last.ctx, last.bots)).filter((x) => x.id !== 0n), "calls still open after 9 minutes").toHaveLength(0);

    expect(events.filter((e) => e.evt === "CRITICAL_unrecoverable_call")).toHaveLength(0);
    expect(events.filter((e) => e.evt === "error")).toHaveLength(0);
    expect(events.filter((e) => e.evt === "expire")).toHaveLength(0);
    const reveals = events.filter((e) => e.evt === "reveal" && e.status === "success");
    const settles = events.filter((e) => e.evt === "settle" && e.status === "success");
    expect(reveals).toHaveLength(committed.length);
    expect(settles).toHaveLength(committed.length);
    for (const r of reveals) {
      expect(TP_SET as readonly number[]).toContain(r.tp);
      expect(SL_SET as readonly number[]).toContain(r.sl);
    }
    console.log(`[bots] skips (benign): ${JSON.stringify(events.filter((e) => e.evt === "skip").map((e) => `${e.label}:${e.reason}`))}`);
  });

  test("on-chain end state: every call Settled by SettlerV1 with a score inside its own bounds", async () => {
    const { ctx } = fresh();
    for (const c of committed) {
      const call = (await ctx.pc.readContract({ address: ctx.deployment.callRegistry, abi: callAbi as Abi, functionName: "getCall", args: [c.id] })) as unknown as Call;
      expect(call.status, `${c.handle} perp ${c.perpId}`).toBe(Status.Settled);
      expect(call.entryPNS).toBeGreaterThan(0n);
      expect(call.scoreBps).toBeGreaterThanOrEqual(-call.slBps);
      expect(call.scoreBps).toBeLessThanOrEqual(call.tpBps);
      expect(call.flags & 1).toBe(1);
      expect([1, 2]).toContain(call.direction);
      if (c.handle === "bot:coinflip") { expect(call.tpBps).toBe(100); expect(call.slBps).toBe(100); }
    }
  });

  test("bots are labelled isBot on-chain and carry the bot: prefix", async () => {
    const { ctx, bots } = fresh();
    for (const b of bots) {
      const cur = (await ctx.pc.readContract({ address: ctx.deployment.curatorRegistry, abi: (await import("../../src/abi/CuratorRegistry.json", { with: { type: "json" } })).default as Abi, functionName: "getCurator", args: [b.address] })) as { isBot: boolean; handle: string; registered: boolean };
      expect(cur.registered).toBe(true);
      expect(cur.isBot).toBe(true);
      expect(cur.handle.startsWith("bot:")).toBe(true);
      expect(cur.handle).toBe(b.spec.handle);
    }
  });

  test("the per-tick cap holds on live state: a forced tick with cap 2 sends exactly 2 txs and defers the rest; the backlog then drains", async () => {
    const { ctx, bots } = fresh();
    ctx.opts!.forceCommit = true;
    ctx.maxTxPerTick = 2;
    events.length = 0;
    await tickAll(ctx, bots);
    const tick = events.find((e) => e.evt === "tick")!;
    expect(tick.txSent).toBe(2);
    expect(tick.deferred).toBe(true);
    expect(events.filter((e) => e.evt === "commit")).toHaveLength(2);

    // drain: normal ticks (cap 3, no forcing) must reveal + settle those 2 calls without errors
    const deadline = Date.now() + 8 * 60_000;
    let last = fresh();
    while (Date.now() < deadline) {
      last = fresh();
      await tickAll(last.ctx, last.bots);
      if ((await openIds(last.ctx, last.bots)).every((x) => x.id === 0n)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect((await openIds(last.ctx, last.bots)).filter((x) => x.id !== 0n), "backlog did not drain").toHaveLength(0);
    expect(events.filter((e) => e.evt === "error" || e.evt === "CRITICAL_unrecoverable_call" || e.evt === "expire")).toHaveLength(0);
  });
});
