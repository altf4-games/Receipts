import type { Abi, Address, Hex } from "viem";
import settlerV2Abi from "./abi/SettlerV2.json" with { type: "json" };
import tapeAbi from "./abi/PriceTape.json" with { type: "json" };
import type { Ctx, Call } from "./tick.js";
import { readOracle } from "./market.js";

/**
 * Keeper fallback for SettlerV2 (the CRE workflow is the primary path). Once the registry's settler is SettlerV2 the keeper
 * must still be able to score calls with nobody running the CRE CLI: it records the endpoint sample when it is missing,
 * proposes the deciding sample, and finalizes after the dispute window. Everything it does is permissionless and verified
 * on chain; racing the CRE workflow is harmless (a duplicate propose/finalize is skipped by the gas estimate).
 * The path logic is the same pure code the CRE workflow uses (cre/tape-and-settle/logic.ts, unit-tested with bun).
 */
import { pickProposal, type CallInfo, type TapeSample } from "../../cre/tape-and-settle/logic.js";

const V2 = settlerV2Abi as Abi;
const TAPE = tapeAbi as Abi;
export const MAX_V2_CALLS_PER_TICK = 6;

export type SendFn = (
  ctx: Ctx, address: Address, abi: Abi, fn: string, args: unknown[], label: string, extra?: Record<string, unknown>,
) => Promise<{ hash: Hex; ok: boolean } | null>;

export interface DueCall { id: bigint; c: Call }

const asInfo = (id: bigint, c: Call): CallInfo => ({
  id, status: c.status, perpId: c.perpId, direction: c.direction, tpBps: c.tpBps, slBps: c.slBps, entryPNS: c.entryPNS,
  entryOracleTs: c.entryOracleTs, horizonEnd: c.horizonEnd, priceDecimals: c.priceDecimals,
});

/** Calls that are Revealed and past their horizon. Returns true when it has done (or deliberately skipped) everything it could. */
export async function keeperV2(ctx: Ctx, due: DueCall[], send: SendFn, budgetLeft: () => boolean): Promise<void> {
  const d = ctx.deployment;
  if (!d.priceTape || !d.settlerV2 || due.length === 0) return;
  const tape = d.priceTape, v2 = d.settlerV2;
  const now = ctx.nowSec();
  const window = BigInt(d.disputeWindow ?? 900);
  due = due.slice(0, MAX_V2_CALLS_PER_TICK);

  // ONE multicall: proposal, endpoint index, path start and tape size for every due call
  let res: { status: string; result?: unknown }[];
  try {
    res = (await ctx.pc.multicall({
      allowFailure: true,
      contracts: due.flatMap(({ id, c }) => [
        { address: v2, abi: V2, functionName: "proposals", args: [id] },
        { address: tape, abi: TAPE, functionName: "firstIndexAtOrAfter", args: [BigInt(c.perpId), c.horizonEnd] },
        { address: tape, abi: TAPE, functionName: "firstIndexAtOrAfter", args: [BigInt(c.perpId), c.entryOracleTs + 1n] },
        { address: tape, abi: TAPE, functionName: "sampleCount", args: [BigInt(c.perpId)] },
      ]),
    } as never)) as never;
  } catch (e) {
    ctx.log({ evt: "error", label: "v2_scan", reason: String((e as Error)?.message ?? e).slice(0, 160) });
    return;
  }
  const sampledPerps = new Set<number>();
  const toPropose: { id: bigint; c: Call; start: bigint; endIdx: bigint }[] = [];
  for (let i = 0; i < due.length; i++) {
    const [pr, endR, startR, cntR] = [res[4 * i], res[4 * i + 1], res[4 * i + 2], res[4 * i + 3]];
    if ([pr, endR, startR, cntR].some((r) => r.status !== "success")) { ctx.log({ evt: "error", label: "v2_scan_item", callId: due[i].id }); continue; }
    const { id, c } = due[i];
    const proposal = pr.result as readonly [bigint, number, number, boolean, boolean, boolean];
    const proposedAt = proposal[0];
    const endIdx = endR.result as bigint, start = startR.result as bigint, count = cntR.result as bigint;
    if (proposedAt !== 0n) {
      if (now >= proposedAt + window && budgetLeft()) await send(ctx, v2, V2, "finalize", [id], "v2_finalize", { callId: id });
      continue; // proposal exists: finalize when the window is over, otherwise wait
    }
    if (endIdx < count) toPropose.push({ id, c, start, endIdx });
    else if (!sampledPerps.has(c.perpId)) {
      // the tape has no sample at/after the horizon: record one as soon as the oracle itself has one
      const o = await readOracle(ctx.pc, d.exchange, BigInt(c.perpId));
      if (o.ts >= c.horizonEnd && budgetLeft()) { sampledPerps.add(c.perpId); await send(ctx, tape, TAPE, "sample", [[BigInt(c.perpId)]], "v2_sample", { perpId: c.perpId, callId: id }); }
      else ctx.log({ evt: "v2_waiting_for_oracle_sample", callId: id, oracleTs: o.ts, horizonEnd: c.horizonEnd });
    }
  }
  if (toPropose.length === 0) return;
  // ONE multicall for every path sample + endpoint of every call to propose
  const wanted: { id: bigint; perpId: number; index: bigint }[] = [];
  for (const p of toPropose) for (let i = p.start; i <= p.endIdx && wanted.length < 120; i++) wanted.push({ id: p.id, perpId: p.c.perpId, index: i });
  let samples: { status: string; result?: unknown }[];
  try {
    samples = (await ctx.pc.multicall({
      allowFailure: true,
      contracts: wanted.map((w) => ({ address: tape, abi: TAPE, functionName: "sampleAt", args: [BigInt(w.perpId), w.index] })),
    } as never)) as never;
  } catch (e) {
    ctx.log({ evt: "error", label: "v2_samples", reason: String((e as Error)?.message ?? e).slice(0, 160) });
    return;
  }
  const byCall = new Map<string, TapeSample[]>();
  wanted.forEach((w, i) => {
    if (samples[i].status !== "success") return;
    const s = samples[i].result as { ts: bigint; price: bigint };
    byCall.set(w.id.toString(), [...(byCall.get(w.id.toString()) ?? []), { index: w.index, ts: s.ts, price: s.price }]);
  });
  for (const p of toPropose) {
    const list = byCall.get(p.id.toString()) ?? [];
    const endpoint = list.find((s) => s.index === p.endIdx);
    if (!endpoint || !budgetLeft()) continue;
    const pick = pickProposal(asInfo(p.id, p.c), list.filter((s) => s.index < p.endIdx), endpoint);
    await send(ctx, v2, V2, "propose", [p.id, Number(pick.index)], "v2_propose", { callId: p.id, index: pick.index, touch: pick.touch, score: pick.score });
  }
}
