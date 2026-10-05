import { describe, expect, test } from "vitest";
import { applyClose, emptyStats, notionalMicroUsd, unixDay } from "../src/lib/stats.js";

describe("CuratorStats bookkeeping (pure)", () => {
  test("equity, peak and max drawdown follow the close order", () => {
    let s = emptyStats(100);
    s = applyClose(s, "settled", 100, 1);
    s = applyClose(s, "settled", 50, 2); // equity 150, peak 150
    s = applyClose(s, "settled", -80, 3); // equity 70, drawdown 80
    s = applyClose(s, "expired", -3000, 4); // equity -2930, drawdown 3080
    s = applyClose(s, "settled", 200, 5); // recovery does not shrink the max drawdown
    expect(s.equityBps).toBe(-2730);
    expect(s.peakEquityBps).toBe(150);
    expect(s.maxDrawdownBps).toBe(3080);
    expect(s.settled).toBe(4);
    expect(s.expired).toBe(1);
    expect(s.wins).toBe(3);
    expect(s.losses).toBe(2);
    expect(s.bestBps).toBe(200);
    expect(s.worstBps).toBe(-3000);
    expect(s.sumScoreBps).toBe(100 + 50 - 80 - 3000 + 200);
    expect(s.sumSqScoreBps).toBe(100n ** 2n + 50n ** 2n + 80n ** 2n + 3000n ** 2n + 200n ** 2n);
    expect(s.lastCloseTime).toBe(5);
  });

  test("best/worst start from the first close, not from zero", () => {
    const s = applyClose(emptyStats(), "settled", -40, 9);
    expect(s.bestBps).toBe(-40);
    expect(s.worstBps).toBe(-40);
    const t = applyClose(applyClose(emptyStats(), "settled", 30, 1), "settled", 10, 2);
    expect(t.bestBps).toBe(30);
    expect(t.worstBps).toBe(10);
  });

  test("a zero score is neither a win nor a loss", () => {
    const s = applyClose(emptyStats(), "settled", 0, 1);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
  });

  test("invalid reveals count as invalid, with the penalty", () => {
    const s = applyClose(emptyStats(), "invalid", -3000, 1);
    expect(s.invalid).toBe(1);
    expect(s.settled).toBe(0);
    expect(s.sumScoreBps).toBe(-3000);
  });
});

describe("Perpl notional scaling", () => {
  test("BTC on testnet: 1.00000 BTC at 86000.0 is 86,000 AUSD", () => {
    expect(notionalMicroUsd(10143, 16, 100_000n, 860_000n)).toBe(86_000_000_000n);
  });
  test("mainnet markets use their own scaling (SOL 3 price / 3 size decimals)", () => {
    expect(notionalMicroUsd(143, 31, 2_000n, 120_500n)).toBe(241_000_000n); // 2.000 SOL at 120.500 = 241 AUSD
  });
  test("an unknown market contributes 0 instead of a guess", () => {
    expect(notionalMicroUsd(10143, 999, 1n, 1n)).toBe(0n);
    expect(notionalMicroUsd(143, 16, 1n, 1n)).toBe(0n); // testnet ids are not mainnet ids
  });
  test("unixDay buckets by UTC day", () => {
    expect(unixDay(0)).toBe(0);
    expect(unixDay(86_399)).toBe(0);
    expect(unixDay(86_400)).toBe(1);
  });
});
