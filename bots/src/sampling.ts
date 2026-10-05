import type { Abi } from "viem";
import tapeAbi from "./abi/PriceTape.json" with { type: "json" };
import { MIN_KEEPER_BALANCE_WEI } from "./config.js";
import type { Ctx } from "./tick.js";
import type { SendFn } from "./v2.js";

const TAPE = tapeAbi as Abi;

/**
 * Path sampling for SettlerV2. A take-profit or stop-loss touch can only be found on the price tape, and the tape only has the
 * samples somebody paid to record. While a market has an open call, the keeper records one oracle sample about every 15
 * minutes (one transaction for all markets that need it), so a touch inside the window is resolved to ~15 minutes instead of
 * "endpoint only". Gas on Monad is billed on the limit: about 0.012 MON for one market and 0.045 MON for four.
 */
export const PATH_SAMPLE_GAP_SECS = 900;
/** do not spend on path samples when the keeper is low: settlement and reveals matter more */
export const PATH_MIN_KEEPER_BALANCE_WEI = MIN_KEEPER_BALANCE_WEI * 10n; // 1 MON

/** Which of the open markets need a new sample: never sampled, or the last sample is at least `gap` seconds old. */
export function planPathSamples(perps: number[], lastTs: Record<number, number | null | undefined>, now: number, gap = PATH_SAMPLE_GAP_SECS): number[] {
  return [...new Set(perps)].sort((a, b) => a - b).filter((p) => {
    const t = lastTs[p];
    return t === null || t === undefined || now - t >= gap;
  });
}

export async function samplePath(ctx: Ctx, perps: number[], keeperBalance: bigint | null, send: SendFn, budgetLeft: () => boolean): Promise<void> {
  const tape = ctx.deployment.priceTape;
  if (!tape || perps.length === 0 || !budgetLeft()) return;
  if (keeperBalance !== null && keeperBalance < PATH_MIN_KEEPER_BALANCE_WEI) { ctx.log({ evt: "path_sample_skipped_low_balance", balanceWei: keeperBalance }); return; }
  const uniq = [...new Set(perps)].sort((a, b) => a - b);
  let lastTs: Record<number, number | null> = {};
  try {
    const counts = (await ctx.pc.multicall({
      allowFailure: true,
      contracts: uniq.map((p) => ({ address: tape, abi: TAPE, functionName: "sampleCount", args: [BigInt(p)] })),
    } as never)) as { status: string; result?: unknown }[];
    const idx = uniq.map((p, i) => ({ p, n: counts[i]?.status === "success" ? (counts[i].result as bigint) : null }));
    const withSamples = idx.filter((x) => x.n !== null && x.n > 0n);
    const last = withSamples.length
      ? ((await ctx.pc.multicall({
          allowFailure: true,
          contracts: withSamples.map((x) => ({ address: tape, abi: TAPE, functionName: "sampleAt", args: [BigInt(x.p), (x.n as bigint) - 1n] })),
        } as never)) as { status: string; result?: unknown }[])
      : [];
    for (const x of idx) {
      if (x.n === null) { lastTs[x.p] = Number.MAX_SAFE_INTEGER; continue; } // unreadable: do not guess, skip this market this tick
      lastTs[x.p] = null;
    }
    withSamples.forEach((x, i) => { lastTs[x.p] = last[i]?.status === "success" ? Number((last[i].result as { ts: bigint }).ts) : Number.MAX_SAFE_INTEGER; });
  } catch (e) {
    ctx.log({ evt: "error", label: "path_scan", reason: String((e as Error)?.message ?? e).slice(0, 160) });
    return;
  }
  const todo = planPathSamples(uniq, lastTs, Number(ctx.nowSec()));
  if (todo.length === 0) return;
  await send(ctx, tape, TAPE, "sample", [todo.map((p) => BigInt(p))], "v2_path_sample", { perpIds: todo.join(",") });
}
