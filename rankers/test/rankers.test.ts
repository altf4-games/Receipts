import { describe, expect, test } from "vitest";
import { ALL_RANKERS, luckAdjusted, meanPerCall, order, raw, sampleSd, wilson, wilsonLower, type CallRow, type CuratorInput } from "../src/index.js";
import { DEFAULT_SIM, mulberry32, simulate } from "../src/coinflipSim.js";

const call = (scoreBps: number | null, status: CallRow["status"] = "SETTLED", callId = 0): CallRow => ({ callId, perpId: 16, status, scoreBps });
const cur = (id: string, scores: (number | null)[], statuses?: CallRow["status"][]): CuratorInput => ({
  id, handle: id, isBot: false, calls: scores.map((s, i) => call(s, statuses?.[i] ?? "SETTLED", i)),
});

describe("order", () => {
  test("higher score first, ties by id, unranked last", () => {
    const rows = order([{ id: "b", score: 5 }, { id: "a", score: 5 }, { id: "c", score: null }, { id: "d", score: 9 }]);
    expect(rows.map((r) => [r.id, r.rank])).toEqual([["d", 1], ["a", 2], ["b", 3], ["c", null]]);
  });
});

describe("raw", () => {
  test("sums closed calls only, penalties included", () => {
    const r = raw.rank([cur("x", [100, -50, -3000], ["SETTLED", "SETTLED", "EXPIRED"]), cur("y", [200, null], ["SETTLED", "SEALED"]), cur("z", [])]);
    expect(r.find((x) => x.id === "x")).toMatchObject({ score: -2950, n: 3, rank: 2 });
    expect(r.find((x) => x.id === "y")).toMatchObject({ score: 200, n: 1, rank: 1 });
    expect(r.find((x) => x.id === "z")).toMatchObject({ score: null, rank: null });
  });
  test("hiding a loss never beats revealing it", () => {
    const revealed = raw.rank([cur("a", [100, -150])])[0]!.score!;
    const hidden = raw.rank([cur("a", [100, -3000], ["SETTLED", "EXPIRED"])])[0]!.score!;
    expect(hidden).toBeLessThan(revealed);
  });
});

describe("luck-adjusted", () => {
  const mk = (n: number, mean: number, spread = 50) => cur(`m${mean}n${n}`, Array.from({ length: n }, (_, i) => (i % 2 === 0 ? mean + spread : mean - spread)));
  test("below minCalls is unranked and says how many calls are missing", () => {
    const r = luckAdjusted(10).rank([mk(9, 100)])[0]!;
    expect(r).toMatchObject({ rank: null, score: null, n: 9 });
    expect(r.detail.needMore).toBe(1);
  });
  test("the same average over more calls ranks higher (the bound tightens)", () => {
    const r = luckAdjusted(10).rank([mk(10, 20), mk(100, 20)]);
    expect(r[0]!.id).toBe("m20n100");
    expect(r[0]!.score!).toBeGreaterThan(r[1]!.score!);
  });
  test("a short hot streak ranks below a long modest record when the calls are noisy", () => {
    const hot = mk(10, 40, 100); // mean +40 over 10 noisy calls: bound = 40 - 1.645 * 105 / 3.16 = about -15
    const solid = mk(120, 15, 100); // mean +15 over 120 noisy calls: bound = 15 - 1.645 * 100 / 10.95 = about 0
    const ranked = luckAdjusted(10).rank([hot, solid]);
    expect(ranked[0]!.id).toBe("m15n120");
    expect(ranked[0]!.score!).toBeGreaterThan(ranked[1]!.score!);
    // the hot streak has the higher mean per call: the ranker is deliberately not fooled by it
    expect(ranked[1]!.detail.mean).toBeGreaterThan(ranked[0]!.detail.mean!);
  });
  test("a clearly better record still wins: the bound is conservative, not blind", () => {
    const strong = mk(40, 60, 50);
    const weak = mk(40, 5, 50);
    expect(luckAdjusted(10).rank([weak, strong])[0]!.id).toBe("m60n40");
  });
  test("the standard deviation is floored so identical calls cannot produce a zero-width bound", () => {
    const flat = cur("flat", Array(20).fill(30));
    expect(sampleSd(flat.calls.map((c) => c.scoreBps as number))).toBe(0);
    const r = luckAdjusted(10).rank([flat])[0]!;
    expect(r.detail.sd).toBe(10);
    expect(r.score).toBeCloseTo(30 - (1.645 * 10) / Math.sqrt(20), 10);
  });
  test("an expired call drags the bound down hard", () => {
    const clean = cur("clean", Array(20).fill(40));
    const hider = cur("hider", [...Array(19).fill(40), -3000], [...Array(19).fill("SETTLED"), "EXPIRED"] as CallRow["status"][]);
    const r = luckAdjusted(10).rank([clean, hider]);
    expect(r[0]!.id).toBe("clean");
  });
});

describe("hit-rate-wilson", () => {
  test("known values", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(10, 10)).toBeCloseTo(0.8, 1); // 10/10 is not 100% when n is small
    expect(wilsonLower(50, 100)).toBeLessThan(0.5);
    expect(wilsonLower(500, 1000)).toBeGreaterThan(wilsonLower(50, 100)); // same rate, more data, higher bound
  });
  test("expired calls are losses", () => {
    const a = cur("a", Array(10).fill(10));
    const b = cur("b", [...Array(9).fill(10), -3000], [...Array(9).fill("SETTLED"), "EXPIRED"] as CallRow["status"][]);
    const r = wilson(10).rank([a, b]);
    expect(r[0]!.id).toBe("a");
  });
});

describe("determinism", () => {
  test("shuffling the input does not change any ranking", () => {
    const rnd = mulberry32(7);
    const curators = Array.from({ length: 20 }, (_, i) => cur(`c${i}`, Array.from({ length: 12 + i }, () => Math.round((rnd() - 0.5) * 300))));
    for (const rk of ALL_RANKERS) {
      const base = JSON.stringify(rk.rank(curators));
      const shuffled = [...curators].sort(() => rnd() - 0.5);
      expect(JSON.stringify(rk.rank(shuffled))).toBe(base);
    }
  });
});

describe("coin-flip illustration (stylised simulation, deterministic; see scripts/coinflip.ts)", () => {
  const all = [raw, meanPerCall, luckAdjusted(10)];
  // Scenario A: a weak real edge (+16 bps per call) and only 60 calls, among 30 coin flippers with 10..120 calls each.
  test("weak edge: luck-adjusted beats both naive rules at putting skill at the top", () => {
    const res = simulate(all, DEFAULT_SIM);
    console.log("[coinflip sim A: weak edge, 60 calls]", JSON.stringify(res));
    expect(res.topIsSkilled["luck-adjusted"]!).toBeGreaterThan(res.topIsSkilled["raw"]!);
    expect(res.topIsSkilled["luck-adjusted"]!).toBeGreaterThan(res.topIsSkilled["mean-per-call"]!);
  });
  // Scenario B: a clear edge (+30 bps per call) over 100 calls. Reported honestly: raw is as good or better when the edge is
  // big and volumes are comparable; the bound is conservative. It must still find the skill most of the time.
  test("clear edge: every rule finds skill; luck-adjusted still does so most of the time", () => {
    const res = simulate(all, { ...DEFAULT_SIM, skillP: 0.65, skilledCalls: 100 });
    console.log("[coinflip sim B: clear edge, 100 calls]", JSON.stringify(res));
    expect(res.topIsSkilled["luck-adjusted"]!).toBeGreaterThan(0.85);
    expect(res.topIsSkilled["luck-adjusted"]!).toBeGreaterThan(res.topIsSkilled["mean-per-call"]!);
  });
});
