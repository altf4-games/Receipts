import { describe, expect, test } from "vitest";
import { alignment, beatsSmartMoney, leanAt, type SmCall, type SmTrade } from "../src/index.js";

const T0 = 1_000_000;
const tr = (dt: number, side: "Long" | "Short", valueUsd: number, symbol = "BTC"): SmTrade => ({ ts: T0 + dt, symbol, side, valueUsd });

describe("leanAt", () => {
  const trades = [tr(-3600, "Long", 100), tr(-7200, "Long", 100), tr(-100, "Short", 50), tr(-50, "Long", 10)];
  test("net long when long value dominates", () => {
    expect(leanAt(trades, "BTC", T0, 0)).toMatchObject({ lean: "LONG", longUsd: 210, shortUsd: 50, trades: 4 });
  });
  test("never looks past the commit time (no hindsight)", () => {
    const withFuture = [...trades, tr(+10, "Short", 100000)];
    expect(leanAt(withFuture, "BTC", T0, 0).lean).toBe("LONG");
  });
  test("ignores other symbols and trades older than the window", () => {
    const x = [tr(-100, "Short", 100, "ETH"), tr(-90000, "Short", 1e6), ...trades];
    expect(leanAt(x, "BTC", T0, 0).trades).toBe(4);
  });
  test("balanced flow is NEUTRAL", () => {
    expect(leanAt([tr(-1, "Long", 100), tr(-2, "Short", 95), tr(-3, "Long", 5)], "BTC", T0, 0).lean).toBe("NEUTRAL");
  });
  test("NO_DATA when the snapshot does not cover the window, or too few trades", () => {
    expect(leanAt(trades, "BTC", T0, T0 - 3600).lean).toBe("NO_DATA");
    expect(leanAt([tr(-1, "Long", 100), tr(-2, "Long", 100)], "BTC", T0, 0).lean).toBe("NO_DATA");
  });
});

describe("alignment", () => {
  const long = { lean: "LONG" as const, longUsd: 1, shortUsd: 0, trades: 5 };
  test("long call with a long lean is with; short is against", () => {
    expect(alignment(1, long)).toBe("with");
    expect(alignment(2, long)).toBe("against");
  });
  test("neutral and no data", () => {
    expect(alignment(1, { ...long, lean: "NEUTRAL" })).toBe("neutral");
    expect(alignment(1, { ...long, lean: "NO_DATA" })).toBe("nodata");
  });
});

describe("beatsSmartMoney", () => {
  const c = (alignment: SmCall["alignment"], scoreBps: number): SmCall => ({ status: "SETTLED", scoreBps, alignment });
  const cur = (id: string, calls: SmCall[]) => ({ id, handle: id, isBot: false, calls });
  test("ranks by the Wilson bound of wins against the lean; follows do not count", () => {
    const r = beatsSmartMoney([
      cur("contrarian", [c("against", 100), c("against", 200), c("against", 50), c("against", -10)]),
      cur("follower", [c("with", 100), c("with", 100), c("with", 100), c("with", 100), c("with", 100)]),
      cur("unlucky", [c("against", -1), c("against", -2), c("against", 5)]),
    ]);
    expect(r.map((x) => [x.id, x.rank])).toEqual([["contrarian", 1], ["unlucky", 2], ["follower", null]]);
    expect(r[2]!.detail.needMore).toBe(3);
  });
  test("a curator needs at least 3 settled calls against the lean", () => {
    expect(beatsSmartMoney([cur("a", [c("against", 100), c("against", 100)])])[0]!.rank).toBeNull();
  });
  test("expired calls are not counted as contrarian calls", () => {
    const x: SmCall = { status: "EXPIRED", scoreBps: -3000, alignment: "against" };
    expect(beatsSmartMoney([cur("a", [x, x, x, x])])[0]!.n).toBe(0);
  });
});
