import { describe, expect, test } from "vitest";
import { coinflip, contrarian, ema, fundingFade, momentum, momentumSignal } from "../../src/strategies.js";
import { SL_SET, TP_SET } from "../../src/params.js";

const ramp = (start: number, step: number, n: number) => Array.from({ length: n }, (_, i) => start + step * i);

describe("strategies (pure functions; test inputs are fixed arrays, not market data)", () => {
  test("ema of a constant series is that constant; ema lags a ramp", () => {
    expect(ema([5, 5, 5, 5], 3)).toBeCloseTo(5, 10);
    expect(ema(ramp(100, 1, 30), 6)).toBeGreaterThan(ema(ramp(100, 1, 30), 18));
  });
  test("rising prices -> momentum goes LONG, contrarian goes SHORT with the same sizes", () => {
    const up = ramp(850_000, 300, 36);
    const m = momentum(up)!, c = contrarian(up)!;
    expect(m.direction).toBe(1);
    expect(c.direction).toBe(2);
    expect(c.tpBps).toBe(m.tpBps);
    expect(c.slBps).toBe(m.slBps);
  });
  test("falling prices -> momentum SHORT, contrarian LONG", () => {
    const down = ramp(850_000, -300, 36);
    expect(momentum(down)!.direction).toBe(2);
    expect(contrarian(down)!.direction).toBe(1);
  });
  test("flat market -> no signal; too little data -> no signal", () => {
    expect(momentum(ramp(850_000, 0, 36))).toBeNull();
    expect(contrarian(ramp(850_000, 0, 36))).toBeNull();
    expect(momentum([1, 2, 3])).toBeNull();
    expect(momentumSignal([])).toBeNull();
  });
  test("emitted sizes always come from the recoverable candidate sets", () => {
    for (const step of [20, 100, 400, 2000, -20, -400, -2000]) {
      const d = momentum(ramp(850_000, step, 36));
      if (!d) continue;
      expect(TP_SET as readonly number[]).toContain(d.tpBps);
      expect(SL_SET as readonly number[]).toContain(d.slBps);
    }
    for (const rate of [-50n, -1n, 1n, 50n]) {
      const d = fundingFade(rate)!;
      expect(TP_SET as readonly number[]).toContain(d.tpBps);
      expect(SL_SET as readonly number[]).toContain(d.slBps);
    }
    for (const b of [0, 1] as const) {
      const d = coinflip(b);
      expect(TP_SET as readonly number[]).toContain(d.tpBps);
      expect(SL_SET as readonly number[]).toContain(d.slBps);
    }
  });
  test("bigger volatility -> wider take-profit/stop", () => {
    const calm = Array.from({ length: 36 }, (_, i) => 850_000 + i * 40 + (i % 2) * 20);
    const wild = Array.from({ length: 36 }, (_, i) => 850_000 + i * 40 + (i % 2 ? 2500 : -2500));
    const a = momentum(calm), b = momentum(wild);
    if (a && b) expect(b.tpBps).toBeGreaterThanOrEqual(a.tpBps);
    expect(momentumSignal(wild)!.sigmaHourBps).toBeGreaterThan(momentumSignal(calm)!.sigmaHourBps);
  });
  test("funding fade: positive funding (longs pay) -> SHORT, negative -> LONG, zero -> none", () => {
    expect(fundingFade(5n)!.direction).toBe(2);
    expect(fundingFade(-5n)!.direction).toBe(1);
    expect(fundingFade(0n)).toBeNull();
  });
  test("coinflip maps the random bit to a direction and nothing else", () => {
    expect(coinflip(1).direction).toBe(1);
    expect(coinflip(0).direction).toBe(2);
  });
});
