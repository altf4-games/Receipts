import { indexer, type Call, type CuratorStats, type MarketStats, type OpenSlot } from "envio";
import { FLAG_DISPUTED, FLAG_PATH_TAPE, UNREVEALED_PENALTY_BPS, applyClose, emptyStats, type CloseKind } from "../lib/stats.js";

// the entity operations this file needs from the handler context (the generated context type is not exported)
type Ops<T> = { get(id: string): Promise<T | undefined>; set(e: T): void; deleteUnsafe(id: string): void };
type Ctx = { CuratorStats: Ops<CuratorStats>; MarketStats: Ops<MarketStats>; OpenSlot: Ops<OpenSlot> };

const marketBase = (perpId: number) => ({
  id: String(perpId), perpId, calls: 0, longs: 0, shorts: 0, settled: 0, expired: 0, wins: 0, sumScoreBps: 0, tapeSamples: 0,
  lastOraclePrice: undefined as bigint | undefined, lastOracleTs: undefined as number | undefined,
});

async function close(context: Ctx, call: Call, kind: CloseKind, scoreBps: number, time: number) {
  const stats = await context.CuratorStats.get(call.curator_id);
  const next = applyClose(
    stats ? { ...stats } : emptyStats(call.commitTime),
    kind, scoreBps, time,
  );
  context.CuratorStats.set({ id: call.curator_id, curator_id: call.curator_id, ...next } as CuratorStats);
  const m = (await context.MarketStats.get(String(call.perpId))) ?? marketBase(call.perpId);
  context.MarketStats.set({
    ...m,
    settled: m.settled + (kind === "settled" ? 1 : 0),
    expired: m.expired + (kind === "expired" ? 1 : 0),
    wins: m.wins + (scoreBps > 0 ? 1 : 0),
    sumScoreBps: m.sumScoreBps + scoreBps,
  });
  context.OpenSlot.deleteUnsafe(`${call.curator_id}-${call.perpId}`);
}

indexer.onEvent({ contract: "CallRegistry", event: "Committed" }, async ({ event, context }) => {
  const p = event.params;
  const curator = p.curator.toLowerCase();
  const perpId = Number(p.perpId);
  const callId = Number(p.callId);
  context.Call.set({
    id: String(callId), callId, curator_id: curator, perpId, status: "SEALED", hash: p.hash, horizonSecs: Number(p.horizonSecs),
    commitBlock: Number(p.commitBlock), commitTime: Number(p.commitTime), horizonEnd: Number(p.horizonEnd), entryPNS: p.entryPNS,
    entryOracleTs: Number(p.entryOracleTs), priceDecimals: Number(p.priceDecimals), direction: undefined, tpBps: undefined, slBps: undefined,
    revealBlock: undefined, revealTime: undefined, scoreBps: undefined, flags: undefined, closeBlock: undefined, closeTime: undefined,
    settler: undefined, pathScored: false, disputed: false, exitPNS: undefined, exitOracleTs: undefined,
    perplTrades: 0, perplLongLots: 0n, perplShortLots: 0n,
  });
  context.OpenSlot.set({ id: `${curator}-${perpId}`, callId });
  const stats = (await context.CuratorStats.get(curator)) ?? { id: curator, curator_id: curator, ...emptyStats(Number(p.commitTime)) };
  context.CuratorStats.set({ ...stats, calls: stats.calls + 1, firstCommitTime: stats.firstCommitTime || Number(p.commitTime) });
  const m = (await context.MarketStats.get(String(perpId))) ?? marketBase(perpId);
  context.MarketStats.set({ ...m, calls: m.calls + 1 });
});

indexer.onEvent({ contract: "CallRegistry", event: "Revealed" }, async ({ event, context }) => {
  const call = await context.Call.get(String(event.params.callId));
  if (!call) return;
  const p = event.params;
  if (!p.valid) {
    // hash matched but a parameter was out of bounds: the contract scores the penalty at once
    const next: Call = { ...call, status: "INVALID", scoreBps: UNREVEALED_PENALTY_BPS, revealBlock: event.block.number, revealTime: event.block.timestamp, closeBlock: event.block.number, closeTime: event.block.timestamp };
    context.Call.set(next);
    await close(context, next, "invalid", UNREVEALED_PENALTY_BPS, event.block.timestamp);
    return;
  }
  context.Call.set({ ...call, status: "REVEALED", direction: Number(p.direction), tpBps: Number(p.tpBps), slBps: Number(p.slBps), revealBlock: event.block.number, revealTime: event.block.timestamp });
  const m = (await context.MarketStats.get(String(call.perpId))) ?? marketBase(call.perpId);
  context.MarketStats.set({ ...m, longs: m.longs + (Number(p.direction) === 1 ? 1 : 0), shorts: m.shorts + (Number(p.direction) === 2 ? 1 : 0) });
});

indexer.onEvent({ contract: "CallRegistry", event: "Expired" }, async ({ event, context }) => {
  const call = await context.Call.get(String(event.params.callId));
  if (!call) return;
  const next: Call = { ...call, status: "EXPIRED", scoreBps: UNREVEALED_PENALTY_BPS, closeBlock: event.block.number, closeTime: event.block.timestamp };
  context.Call.set(next);
  await close(context, next, "expired", UNREVEALED_PENALTY_BPS, event.block.timestamp);
});

indexer.onEvent({ contract: "CallRegistry", event: "Closed" }, async ({ event, context }) => {
  const call = await context.Call.get(String(event.params.callId));
  if (!call) return;
  const flags = Number(event.params.flags);
  const scoreBps = Number(event.params.scoreBps);
  const next: Call = {
    ...call, status: "SETTLED", scoreBps, flags, closeBlock: event.block.number, closeTime: event.block.timestamp,
    settler: event.params.settler.toLowerCase(), pathScored: (flags & FLAG_PATH_TAPE) !== 0, disputed: (flags & FLAG_DISPUTED) !== 0,
  };
  context.Call.set(next);
  await close(context, next, "settled", scoreBps, event.block.timestamp);
});

// SettlerV1 emits the exit price next to the registry's Closed event (same transaction, later log).
indexer.onEvent({ contract: "SettlerV1", event: "Settled" }, async ({ event, context }) => {
  const call = await context.Call.get(String(event.params.callId));
  if (call) context.Call.set({ ...call, exitPNS: event.params.exitPNS, exitOracleTs: Number(event.params.exitOracleTs) });
});

indexer.onEvent({ contract: "CallRegistry", event: "SettlerChanged" }, async ({ event, context }) => {
  context.SettlerChange.set({
    id: `${event.block.number}-${event.logIndex}`, oldSettler: event.params.oldSettler.toLowerCase(), newSettler: event.params.newSettler.toLowerCase(),
    block: event.block.number, timestamp: event.block.timestamp,
  });
});
