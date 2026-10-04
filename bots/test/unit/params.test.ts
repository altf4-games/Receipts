import { describe, expect, test } from "vitest";
import type { Address, Hex } from "viem";
import { DIRS, SL_SET, TP_SET, botSecret, callHash, deriveSalt, inCommitWindow, jitteredHorizon, nearest, recoverParams } from "../../src/params.js";

const MASTER: Hex = "0x" + "ab".repeat(32) as Hex;
const REG: Address = "0x1E9b6c2e6484CcbeA63F4567905012a28Fa1753C";
const CUR: Address = "0x64DB6511c52E7fbE338e3c9a2c1a4F0Bb381a8Ff";

describe("stateless salt + parameter recovery", () => {
  test("every (direction, tp, sl) the strategies can emit is recoverable from the on-chain hash alone", () => {
    const secret = botSecret(MASTER, "bot:momentum");
    let n = 0;
    for (const perpId of [16n, 32n, 48n]) {
      const horizonSecs = jitteredHorizon(3600, 1_791_100_000n + BigInt(n));
      const salt = deriveSalt(secret, perpId, horizonSecs);
      for (const direction of DIRS) for (const tpBps of TP_SET) for (const slBps of SL_SET) {
        const onchainHash = callHash({ chainId: 10143, registry: REG, curator: CUR, perpId, direction, tpBps, slBps, horizonSecs, salt });
        const rec = recoverParams({ chainId: 10143, registry: REG, curator: CUR, perpId, horizonSecs, secret, onchainHash });
        expect(rec, `perp ${perpId} dir ${direction} tp ${tpBps} sl ${slBps}`).toEqual({ direction, tpBps, slBps, salt });
        n++;
      }
    }
    expect(n).toBe(3 * 2 * 5 * 5);
  });

  test("wrong secret, wrong curator, wrong horizon or wrong chain do NOT recover (no false positives)", () => {
    const secret = botSecret(MASTER, "bot:momentum");
    const horizonSecs = 3700;
    const salt = deriveSalt(secret, 16n, horizonSecs);
    const onchainHash = callHash({ chainId: 10143, registry: REG, curator: CUR, perpId: 16n, direction: 1, tpBps: 100, slBps: 75, horizonSecs, salt });
    const base = { chainId: 10143, registry: REG, curator: CUR, perpId: 16n, horizonSecs, secret, onchainHash };
    expect(recoverParams(base)).not.toBeNull();
    expect(recoverParams({ ...base, secret: botSecret(MASTER, "bot:contrarian") })).toBeNull();
    expect(recoverParams({ ...base, secret: botSecret("0x" + "cd".repeat(32) as Hex, "bot:momentum") })).toBeNull();
    expect(recoverParams({ ...base, curator: "0x1984aAA5FC0914FD7Bc589140E4EE3b4Ed6714e5" })).toBeNull();
    expect(recoverParams({ ...base, horizonSecs: horizonSecs + 1 })).toBeNull();
    expect(recoverParams({ ...base, chainId: 143 })).toBeNull();
    expect(recoverParams({ ...base, perpId: 32n })).toBeNull();
  });

  test("params outside the candidate set are reported as unrecoverable, not guessed", () => {
    const secret = botSecret(MASTER, "bot:x");
    const salt = deriveSalt(secret, 16n, 3600);
    const onchainHash = callHash({ chainId: 10143, registry: REG, curator: CUR, perpId: 16n, direction: 1, tpBps: 123, slBps: 77, horizonSecs: 3600, salt });
    expect(recoverParams({ chainId: 10143, registry: REG, curator: CUR, perpId: 16n, horizonSecs: 3600, secret, onchainHash })).toBeNull();
  });

  test("salts differ per bot, per market and per horizon", () => {
    const a = deriveSalt(botSecret(MASTER, "bot:a"), 16n, 3600);
    expect(a).not.toBe(deriveSalt(botSecret(MASTER, "bot:b"), 16n, 3600));
    expect(a).not.toBe(deriveSalt(botSecret(MASTER, "bot:a"), 32n, 3600));
    expect(a).not.toBe(deriveSalt(botSecret(MASTER, "bot:a"), 16n, 3601));
  });

  test("horizon jitter stays in [base, base+599] and follows the minute", () => {
    for (let t = 1_791_000_000n; t < 1_791_000_000n + 60n * 1300n; t += 61n) {
      const h = jitteredHorizon(3600, t);
      expect(h).toBeGreaterThanOrEqual(3600);
      expect(h).toBeLessThanOrEqual(3600 + 599);
    }
    expect(jitteredHorizon(3600, 120n)).toBe(3602);
  });

  test("nearest() snaps to the closest allowed value, ties resolved deterministically", () => {
    expect(nearest(TP_SET, 0)).toBe(50);
    expect(nearest(TP_SET, 9999)).toBe(300);
    expect(nearest(TP_SET, 120)).toBe(100);
    expect(nearest(TP_SET, 130)).toBe(150);
    expect(nearest(SL_SET, 80)).toBe(75);
  });
});

describe("commit windows (stateless cadence)", () => {
  const PERIOD = 8 * 3600, WINDOW = 20 * 60;
  test("each (bot, market) pair is in-window for exactly WINDOW seconds per PERIOD", () => {
    for (const handle of ["bot:momentum", "bot:coinflip"]) for (const perp of [16n, 32n, 48n]) {
      let inside = 0;
      const start = 1_791_000_000n;
      for (let s = 0n; s < BigInt(PERIOD); s += 10n) if (inCommitWindow(handle, perp, start + s, PERIOD, WINDOW)) inside += 10;
      expect(inside, `${handle} ${perp}`).toBe(WINDOW);
    }
  });
  test("pattern repeats every period and different pairs are staggered", () => {
    const t = 1_791_012_345n;
    expect(inCommitWindow("bot:momentum", 16n, t, PERIOD, WINDOW)).toBe(inCommitWindow("bot:momentum", 16n, t + BigInt(PERIOD), PERIOD, WINDOW));
    const handles = ["bot:momentum", "bot:funding-fade", "bot:coinflip", "bot:contrarian"];
    const offsets = new Set<string>();
    for (const h of handles) for (const p of [16n, 32n, 48n]) {
      for (let s = 0n; s < BigInt(PERIOD); s += 60n) if (inCommitWindow(h, p, 1_791_000_000n + s, PERIOD, WINDOW)) { offsets.add(`${h}:${p}:${s}`); break; }
    }
    const starts = [...offsets].map((o) => o.split(":").pop());
    expect(new Set(starts).size).toBeGreaterThan(8); // 12 pairs, mostly distinct start minutes
  });
});
