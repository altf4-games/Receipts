/**
 * UNIT test with stubbed RPC (mocks are allowed in unit tests only; never counted as proof; the live lifecycle test is the proof).
 * Checks the scheduling rule: with a per-tick transaction cap, deadline-sensitive work (reveal/expire) is ALWAYS served
 * before settles, and settles before new commits.
 */
import { describe, expect, test } from "vitest";
import type { Address, Hex } from "viem";
import { BOTS, type Deployment } from "../../src/config.js";
import { botSecret, callHash, deriveSalt } from "../../src/params.js";
import { Status, tickAll, type BotRuntime, type Call, type Ctx } from "../../src/tick.js";

const MASTER: Hex = ("0x" + "ab".repeat(32)) as Hex;
const D: Deployment & { settlerV2: Address } = {
  chainId: 10143, callRegistry: "0x1E9b6c2e6484CcbeA63F4567905012a28Fa1753C", curatorRegistry: "0x1e917319c379fd4e62Bf3207379E3d8bb1A468AF",
  settlerV1: "0xF39358B88cF73a1d9158f00b9D5E39A04543E03f", exchange: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
  bondToken: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", minBond: 50_000_000, minHorizon: 900, maxOracleAge: 120,
  settlerV2: "0x4400D7ca5f75C2ea4D4e99C4A5cb07Fe7e5e851C",
};
const NOW = 1_800_000_000n;
const addr = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as Address;

function setup(opts: { cap: number; calls: Record<string, Partial<Call>>; forceCommit?: boolean; extraCalls?: Record<string, Partial<Call>>; v2?: Record<string, unknown> }) {
  const sent: string[] = [];
  const sentArgs: unknown[][] = [];
  const multicalls: number[] = [];
  const coinflip = BOTS.find((b) => b.strategy === "coinflip")!;
  const specs = [{ ...coinflip, handle: "bot:coinflip", markets: [16n, 32n] }, { ...coinflip, handle: "bot:coinflip2", markets: [16n] }];
  const signersBuilt: string[] = [];
  const bots: BotRuntime[] = specs.map((spec, i) => ({
    spec,
    address: addr(100 + i),
    getSigner: () => {
      signersBuilt.push(spec.handle);
      return { account: { address: addr(100 + i) } as never, client: { chain: {}, writeContract: async (a: { functionName: string; args: unknown[] }) => { sent.push(a.functionName); return ("0x" + sent.length.toString(16).padStart(64, "0")) as Hex; } } as never };
    },
  }));
  const openId: Record<string, bigint> = {};
  let nextId = 1n;
  for (const [key] of Object.entries(opts.calls)) openId[key] = nextId++;
  // human calls take the ids right after the bots' open calls
  const extraIds = Object.keys(opts.extraCalls ?? {});
  const pc = {
    getBalance: async () => 10n ** 19n,
    readContract: async (a: { functionName: string; args: unknown[] }) => {
      if (a.functionName === "openCallId") return openId[`${(a.args[0] as string).toLowerCase()}:${a.args[1]}`] ?? 0n;
      if (a.functionName === "settler") return opts.v2 ? D.settlerV2 : D.settlerV1;
      if (a.functionName === "proposals") return (opts.v2 as { proposals?: Record<string, unknown[]> })?.proposals?.[String(a.args[0])] ?? [0n, 0, 0, false, false, false];
      if (a.functionName === "firstIndexAtOrAfter") { const v = opts.v2 as { start: bigint; endIdx: bigint }; return a.args[1] === NOW - 10n ? v.endIdx : v.start; }
      if (a.functionName === "sampleCount") return (opts.v2 as { count: bigint }).count;
      if (a.functionName === "sampleAt") return (opts.v2 as { samples: Record<string, unknown> }).samples[String(a.args[1])];
      if (a.functionName === "nextCallId") return nextId + BigInt(Object.keys(opts.extraCalls ?? {}).length);
      if (a.functionName === "getCall") {
        const extra = (opts.extraCalls ?? {})[String(a.args[0])];
        if (extra) return { status: Status.Sealed, horizonSecs: 3600, commitTime: NOW - 7200n, horizonEnd: NOW - 100n, hash: "0x" + "00".repeat(32), perpId: 16, curator: addr(900), ...extra };
        const key = Object.keys(openId).find((k) => openId[k] === a.args[0]);
        if (!key) return { status: Status.None, horizonEnd: 0n, curator: addr(0) };
        return { status: Status.Sealed, horizonSecs: 3600, commitTime: NOW - 3000n, horizonEnd: NOW + 600n, hash: "0x" + "00".repeat(32), ...opts.calls[key] };
      }
      throw new Error("unexpected read " + a.functionName);
    },
    multicall: async (a: { contracts: { functionName: string; args: unknown[] }[] }) => {
      multicalls.push(a.contracts.length);
      return Promise.all(a.contracts.map(async (c) => ({ status: "success", result: await (pc as { readContract: (x: unknown) => Promise<unknown> }).readContract(c) })));
    },
    estimateContractGas: async () => 100_000n,
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1n }),
    call: async () => ({ data: ("0x" + "00".repeat(32) + "00".repeat(32 * 15) + (1_800_000_100n).toString(16).padStart(64, "0") + (1_800_000_100n).toString(16).padStart(64, "0")) as Hex }),
  };
  const ctx: Ctx = {
    pc: pc as never, deployment: opts.v2 ? ({ ...D, settlerV2: "0x4400D7ca5f75C2ea4D4e99C4A5cb07Fe7e5e851C", priceTape: "0x050e4F35D946BF83AcD7C1D60c9512D308c078fA", disputeWindow: 900 } as Deployment) : D, perplApi: "http://unused", masterSecret: MASTER,
    keeperAddress: addr(1),
    getKeeper: () => {
      signersBuilt.push("keeper");
      return { account: { address: addr(1) } as never, client: { chain: {}, writeContract: async (a: { functionName: string; args?: unknown[] }) => { sent.push(a.functionName); sentArgs.push(a.args ?? []); return ("0x" + sent.length.toString(16).padStart(64, "0")) as Hex; } } as never };
    },
    nowSec: () => NOW, log: () => {}, maxTxPerTick: opts.cap, opts: { forceCommit: opts.forceCommit ?? false },
  };
  return { ctx, bots, sent, sentArgs, signersBuilt, multicalls };
}

/** a Sealed call whose hash matches what bot:coinflip would have committed (so recovery succeeds) */
function sealedFor(bot: string, curator: Address, perpId: bigint, horizonSecs: number): Partial<Call> {
  const salt = deriveSalt(botSecret(MASTER, bot), perpId, horizonSecs);
  return { hash: callHash({ chainId: 10143, registry: D.callRegistry, curator, perpId, direction: 1, tpBps: 100, slBps: 100, horizonSecs, salt }), horizonSecs };
}

describe("per-tick budget goes to deadline-sensitive work first", () => {
  test("cap 1: an overdue reveal is sent, the forced commit on a free pair is deferred", async () => {
    const s = setup({ cap: 1, forceCommit: true, calls: {} });
    const bot0 = s.bots[0].address;
    // bot0 / market 16 holds a Sealed call that is past half its horizon (reveal due); market 32 and bot1/16 are free
    s.ctx.pc = ((): never => {
      const base = setup({ cap: 1, forceCommit: true, calls: { [`${bot0.toLowerCase()}:16`]: sealedFor("bot:coinflip", bot0, 16n, 3600) } });
      s.sent.length = 0;
      return base.ctx.pc as never;
    })();
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["reveal"]); // exactly one tx, and it is the reveal; commits were deferred
  });

  test("cap 2: reveal first, then the settle-free tick spends the remainder on a commit", async () => {
    const s = setup({ cap: 2, forceCommit: true, calls: {} });
    const bot0 = s.bots[0].address;
    s.ctx.pc = setup({ cap: 2, forceCommit: true, calls: { [`${bot0.toLowerCase()}:16`]: sealedFor("bot:coinflip", bot0, 16n, 3600) } }).ctx.pc as never;
    await tickAll(s.ctx, s.bots);
    expect(s.sent[0]).toBe("reveal");
    expect(s.sent[1]).toBe("commit");
    expect(s.sent).toHaveLength(2);
  });

  test("an overdue unrevealed call is expired before any commit", async () => {
    const s = setup({ cap: 1, forceCommit: true, calls: {} });
    const bot0 = s.bots[0].address;
    s.ctx.pc = setup({ cap: 1, forceCommit: true, calls: { [`${bot0.toLowerCase()}:16`]: { ...sealedFor("bot:coinflip", bot0, 16n, 3600), horizonEnd: NOW - 1n } } }).ctx.pc as never;
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["expire"]);
  });

  test("without a cap problem (cap 10) everything still happens: reveal + commits", async () => {
    const s = setup({ cap: 10, forceCommit: true, calls: {} });
    const bot0 = s.bots[0].address;
    s.ctx.pc = setup({ cap: 10, forceCommit: true, calls: { [`${bot0.toLowerCase()}:16`]: sealedFor("bot:coinflip", bot0, 16n, 3600) } }).ctx.pc as never;
    await tickAll(s.ctx, s.bots);
    expect(s.sent.filter((x) => x === "reveal")).toHaveLength(1);
    expect(s.sent.filter((x) => x === "commit")).toHaveLength(2); // bot0/32 and bot1/16 are free
  });

  test("an IDLE tick (nothing due, nobody in a commit window) builds no signer at all and sends nothing (cheap on a cold isolate)", async () => {
    const s = setup({ cap: 3, forceCommit: false, calls: {} });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 }; // no pair is in its commit window
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual([]);
    expect(s.signersBuilt).toEqual([]); // no account creation = no ~11 ms cold-start CPU
  });

  test("the scan is ONE multicall for all pairs (+ one more for open calls), not one request per pair", async () => {
    const s = setup({ cap: 3, forceCommit: false, calls: {} });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.multicalls).toEqual([5]); // 2 bots x markets (2 + 1) = 3 reads, a single multicall; no open calls => no second one
    const bot0 = s.bots[0].address;
    const t = setup({ cap: 3, forceCommit: false, calls: { [`${bot0.toLowerCase()}:16`]: sealedFor("bot:coinflip", bot0, 16n, 3600) } });
    t.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(t.ctx, t.bots);
    expect(t.multicalls).toEqual([5, 1]); // pairs, then the one open call
  });

  test("a signer is built only for the wallet that actually sends (keeper for a reveal, not the bots)", async () => {
    const s = setup({ cap: 1, forceCommit: false, calls: {} });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    const bot0 = s.bots[0].address;
    s.ctx.pc = setup({ cap: 1, forceCommit: false, calls: { [`${bot0.toLowerCase()}:16`]: sealedFor("bot:coinflip", bot0, 16n, 3600) } }).ctx.pc as never;
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["reveal"]);
    expect(s.signersBuilt).toEqual(["keeper"]);
  });

  test("human curators' calls: a revealed call past its horizon is settled by the keeper", async () => {
    const s = setup({ cap: 3, forceCommit: false, calls: {}, extraCalls: { "1": { status: Status.Revealed, horizonEnd: NOW - 10n } } });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["settle"]);
  });

  test("human curators' calls: an unrevealed call past its horizon is expired (the keeper can never reveal it)", async () => {
    const s = setup({ cap: 3, forceCommit: false, calls: {}, extraCalls: { "1": { status: Status.Sealed, horizonEnd: NOW - 10n } } });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["expire"]);
  });

  test("human curators' calls: nothing happens before the horizon, and finished calls are ignored", async () => {
    const s = setup({
      cap: 3, forceCommit: false, calls: {},
      extraCalls: { "1": { status: Status.Sealed, horizonEnd: NOW + 600n }, "2": { status: Status.Revealed, horizonEnd: NOW + 1n }, "3": { status: Status.Settled, horizonEnd: NOW - 500n } },
    });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual([]);
  });

  test("with a cap of one transaction, a bot's overdue reveal goes before a human call's settle", async () => {
    const bot0 = setup({ cap: 1, calls: {} }).bots[0].address;
    const s = setup({
      cap: 1, forceCommit: false,
      calls: { [`${bot0.toLowerCase()}:16`]: sealedFor("bot:coinflip", bot0, 16n, 3600) },
      extraCalls: { "2": { status: Status.Revealed, horizonEnd: NOW - 10n } },
    });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["reveal"]);
  });

  // ---- SettlerV2 mode (registry settler == SettlerV2): the keeper proposes / samples / finalizes from the tape
  const humanRevealed = { status: Status.Revealed, perpId: 16, direction: 1, tpBps: 100, slBps: 100, entryPNS: 850_000n, entryOracleTs: NOW - 4000n, horizonEnd: NOW - 10n, priceDecimals: 1 };

  test("V2: a revealed human call with its endpoint on the tape gets a PROPOSAL from the first touching sample (not V1 settle)", async () => {
    const s = setup({
      cap: 3, calls: {}, extraCalls: { "1": humanRevealed },
      v2: { start: 0n, endIdx: 2n, count: 3n, samples: {
        "0": { ts: NOW - 3000n, price: 850_100n }, "1": { ts: NOW - 2000n, price: 859_000n }, "2": { ts: NOW - 5n, price: 851_000n },
      } },
    });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["propose"]);
    expect(s.sentArgs[0]).toEqual([1n, 1]); // sample index 1 (+1.06%) touches TP first; index 2 is the endpoint and must NOT be proposed
  });

  test("V2: finalize only after the dispute window", async () => {
    const early = setup({ cap: 3, calls: {}, extraCalls: { "1": humanRevealed }, v2: { start: 0n, endIdx: 1n, count: 2n, samples: {}, proposals: { "1": [NOW - 100n, 1, 5, false, false, false] } } });
    early.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(early.ctx, early.bots);
    expect(early.sent).toEqual([]); // window (900 s) still open
    const late = setup({ cap: 3, calls: {}, extraCalls: { "1": humanRevealed }, v2: { start: 0n, endIdx: 1n, count: 2n, samples: {}, proposals: { "1": [NOW - 901n, 1, 5, false, false, false] } } });
    late.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(late.ctx, late.bots);
    expect(late.sent).toEqual(["finalize"]);
  });

  test("V2: no endpoint sample on the tape yet and the oracle has one => the keeper records it", async () => {
    const s = setup({ cap: 3, calls: {}, extraCalls: { "1": humanRevealed }, v2: { start: 0n, endIdx: 2n, count: 2n, samples: {} } });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["sample"]); // the stub oracle reports a timestamp after the horizon
  });

  test("V2: an unrevealed human call past its horizon is still expired", async () => {
    const s = setup({ cap: 3, calls: {}, extraCalls: { "1": { ...humanRevealed, status: Status.Sealed } }, v2: { start: 0n, endIdx: 0n, count: 0n, samples: {} } });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["expire"]);
  });

  // ---- V2 path sampling: while a market has a call inside its window, the keeper keeps the tape dense
  const openBotCall = (bot0: string) => ({ [`${bot0.toLowerCase()}:16`]: { perpId: 16, commitTime: NOW - 100n, horizonEnd: NOW + 3500n, horizonSecs: 3600 } });

  test("V2 path sampling: an open call on a market whose tape is empty gets ONE sample transaction for that market", async () => {
    const probe = setup({ cap: 3, calls: {} });
    const s = setup({ cap: 3, calls: openBotCall(probe.bots[0].address), v2: { start: 0n, endIdx: 0n, count: 0n, samples: {} } });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual(["sample"]);
    expect(s.sentArgs[0]).toEqual([[16n]]);
  });

  test("V2 path sampling: a recent sample on the tape means no transaction", async () => {
    const probe = setup({ cap: 3, calls: {} });
    const s = setup({ cap: 3, calls: openBotCall(probe.bots[0].address), v2: { start: 0n, endIdx: 0n, count: 2n, samples: { "1": { ts: NOW - 60n, price: 1n } } } });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).toEqual([]);
  });

  test("V1 mode never path-samples", async () => {
    const probe = setup({ cap: 3, calls: {} });
    const s = setup({ cap: 3, calls: openBotCall(probe.bots[0].address) });
    s.ctx.cadence = { periodSecs: 3600, windowSecs: 0 };
    await tickAll(s.ctx, s.bots);
    expect(s.sent).not.toContain("sample");
  });
});

