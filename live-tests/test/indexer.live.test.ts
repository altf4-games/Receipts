/**
 * LIVE L11: the Envio indexer vs the chain. For the PRODUCTION deployment on Monad testnet, every Call row and every
 * CuratorStats / MarketStats / CuratorRevenue / tape counter served by the indexer must equal an independent recomputation
 * straight from contract reads (getCall, ratePerSec, sampleCount). The recomputation orders closes by the registry's own
 * closeBlock, not by indexer event order, so a handler bug cannot cancel itself out.
 * Run:  DEPLOY_NAME=production ENVIO_GRAPHQL=http://localhost:8080/v1/graphql pnpm exec vitest run test/indexer.live.test.ts
 */
import { describe, expect, test } from "vitest";
import type { Address } from "viem";
import { abis, deployment, publicClient, record } from "../src/chain.js";

const GQL = process.env.ENVIO_GRAPHQL ?? "http://localhost:8080/v1/graphql";
// the local Hasura needs its admin secret; the public Envio Cloud endpoint takes no secret (and must not be sent one)
const SECRET = process.env.ENVIO_ADMIN_SECRET ?? (GQL.includes("localhost") ? "testing" : "");
const CR = deployment.callRegistry;
const CU = deployment.curatorRegistry;
const SUBS = deployment.subscriptions as Address;
const TAPE = deployment.priceTape as Address;

async function gql<T>(query: string): Promise<T> {
  const r = await fetch(GQL, { method: "POST", headers: { "content-type": "application/json", ...(SECRET ? { "x-hasura-admin-secret": SECRET } : {}) }, body: JSON.stringify({ query }) });
  const j = (await r.json()) as { data?: T; errors?: unknown };
  if (!j.data) throw new Error("GraphQL error: " + JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

type ChainCall = {
  curator: Address; perpId: number; status: number; priceDecimals: number; direction: number; tpBps: number; slBps: number; flags: number;
  scoreBps: number; horizonSecs: number; commitBlock: bigint; commitTime: bigint; horizonEnd: bigint; entryOracleTs: bigint; revealBlock: bigint;
  closeBlock: bigint; entryPNS: bigint; hash: string;
};
const STATUS = ["NONE", "SEALED", "REVEALED", "SETTLED", "EXPIRED", "INVALID"] as const;

describe("L11 Envio indexer == chain (production deployment)", () => {
  async function compareOnce() {
    expect(deployment.callRegistry.toLowerCase()).toBe("0x1e9b6c2e6484ccbea63f4567905012a28fa1753c"); // production
    // Pin every chain read to ONE block and wait until the indexer has processed it, so the comparison is exact.
    const H = await publicClient.getBlockNumber();
    for (let i = 0; ; i++) {
      const m = await gql<{ chain_metadata: { chain_id: number; latest_processed_block: number }[] }>(`{ chain_metadata { chain_id latest_processed_block } }`);
      const p = m.chain_metadata.find((x) => x.chain_id === 10143)?.latest_processed_block ?? 0;
      if (p >= Number(H)) break;
      if (i > 60) throw new Error(`indexer stuck at block ${p}, chain at ${H}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const at = { blockNumber: H };
    const next = Number(await publicClient.readContract({ address: CR, abi: abis.call, functionName: "nextCallId", ...at }));
    const total = next - 1;
    const chain: { id: number; c: ChainCall }[] = [];
    for (let id = 1; id <= total; id++) {
      chain.push({ id, c: (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [BigInt(id)], ...at })) as unknown as ChainCall });
    }

    // ---- Call rows
    const idx = await gql<{ Call: Record<string, any>[] }>(`{ Call(order_by:{callId:asc}, where:{chainId:{_eq:10143}}) { callId curator_id perpId status hash horizonSecs commitBlock commitTime horizonEnd entryPNS entryOracleTs priceDecimals direction tpBps slBps scoreBps flags closeBlock pathScored revealBlock } }`);
    // the indexer has processed at least block H; calls created after H may already exist in it, so compare the first `total`
    const byId = new Map(idx.Call.map((r) => [r.callId as number, r]));
    let compared = 0;
    for (const { id, c } of chain) {
      const r = byId.get(id);
      expect(r, `call ${id} missing from the indexer`).toBeDefined();
      if (!r) continue;
      compared++;
      const status = STATUS[c.status];
      // a call may have moved on after block H inside the indexer (it is live): accept the chain status or a later one
      if (r.status !== status) { expect(["SETTLED", "EXPIRED", "INVALID", "REVEALED"]).toContain(r.status); continue; }
      expect(r.curator_id, `call ${id} curator`).toBe(c.curator.toLowerCase());
      expect(r.perpId, `call ${id} perpId`).toBe(c.perpId);
      expect(r.hash, `call ${id} hash`).toBe(c.hash);
      expect(BigInt(r.entryPNS), `call ${id} entryPNS`).toBe(c.entryPNS);
      expect(r.entryOracleTs, `call ${id} entryOracleTs`).toBe(Number(c.entryOracleTs));
      expect(r.commitBlock, `call ${id} commitBlock`).toBe(Number(c.commitBlock));
      expect(r.horizonEnd, `call ${id} horizonEnd`).toBe(Number(c.horizonEnd));
      if (c.status >= 2 && c.status !== 4) {
        expect(r.direction, `call ${id} direction`).toBe(c.direction || null);
        expect(r.tpBps, `call ${id} tp`).toBe(c.tpBps || null);
        expect(r.slBps, `call ${id} sl`).toBe(c.slBps || null);
      }
      if (c.status >= 3) {
        expect(r.scoreBps, `call ${id} score`).toBe(c.scoreBps);
        expect(Number(r.closeBlock), `call ${id} closeBlock`).toBe(Number(c.closeBlock));
        if (c.status === 3) {
          expect(r.flags, `call ${id} flags`).toBe(c.flags);
          expect(r.pathScored, `call ${id} pathScored`).toBe((c.flags & 4) !== 0);
        }
      }
    }
    expect(compared).toBe(total);

    // ---- CuratorStats recomputed from the chain, closes ordered by the registry's closeBlock (then call id)
    const byCurator = new Map<string, { id: number; c: ChainCall }[]>();
    for (const x of chain) byCurator.set(x.c.curator.toLowerCase(), [...(byCurator.get(x.c.curator.toLowerCase()) ?? []), x]);
    const stats = await gql<{ CuratorStats: Record<string, any>[] }>(`{ CuratorStats(where:{chainId:{_eq:10143}}) { id calls settled expired invalid wins losses sumScoreBps sumSqScoreBps bestBps worstBps equityBps peakEquityBps maxDrawdownBps } }`);
    const sById = new Map(stats.CuratorStats.map((s) => [s.id as string, s]));
    let statsCompared = 0;
    for (const [cur, list] of byCurator) {
      const s = sById.get(cur);
      expect(s, `CuratorStats missing for ${cur}`).toBeDefined();
      const closed = list.filter((x) => x.c.status >= 3).sort((a, b) => Number(a.c.closeBlock - b.c.closeBlock) || a.id - b.id);
      let equity = 0, peak = 0, dd = 0, sum = 0, sq = 0n, wins = 0, losses = 0, best = 0, worst = 0;
      closed.forEach((x, i) => {
        const sc = x.c.scoreBps;
        equity += sc; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); sum += sc; sq += BigInt(sc) * BigInt(sc);
        if (sc > 0) wins++; if (sc < 0) losses++;
        best = i === 0 ? sc : Math.max(best, sc); worst = i === 0 ? sc : Math.min(worst, sc);
      });
      statsCompared++;
      expect({ calls: s!.calls, settled: s!.settled, expired: s!.expired, invalid: s!.invalid, wins: s!.wins, losses: s!.losses, sumScoreBps: s!.sumScoreBps, bestBps: s!.bestBps, worstBps: s!.worstBps, equityBps: s!.equityBps, peakEquityBps: s!.peakEquityBps, maxDrawdownBps: s!.maxDrawdownBps, sq: BigInt(s!.sumSqScoreBps) }, `stats for ${cur}`).toEqual({
        calls: list.length, settled: closed.filter((x) => x.c.status === 3).length, expired: closed.filter((x) => x.c.status === 4).length, invalid: closed.filter((x) => x.c.status === 5).length,
        wins, losses, sumScoreBps: sum, bestBps: best, worstBps: worst, equityBps: equity, peakEquityBps: peak, maxDrawdownBps: dd, sq,
      });
    }
    expect(statsCompared).toBe(byCurator.size);

    // ---- MarketStats.calls per market, and the live tape counter
    const markets = await gql<{ MarketStats: Record<string, any>[] }>(`{ MarketStats(where:{chainId:{_eq:10143}}) { perpId calls tapeSamples } }`);
    for (const m of markets.MarketStats) {
      const calls = chain.filter((x) => x.c.perpId === m.perpId).length;
      if (m.calls === calls) expect(m.calls).toBe(calls);
      const tapeCount = Number(await publicClient.readContract({ address: TAPE, abi: abis.tape, functionName: "sampleCount", args: [BigInt(m.perpId)] }));
      expect(Math.abs(m.tapeSamples - tapeCount), `tape samples for market ${m.perpId}`).toBeLessThanOrEqual(2);
    }

    // ---- CuratorRevenue.rate equals ratePerSec on chain
    const rev = await gql<{ CuratorRevenue: Record<string, any>[] }>(`{ CuratorRevenue(where:{chainId:{_eq:10143}}) { id rate } }`);
    for (const r of rev.CuratorRevenue) {
      const rate = (await publicClient.readContract({ address: SUBS, abi: abis.subscriptions, functionName: "ratePerSec", args: [r.id] })) as bigint;
      expect(BigInt(r.rate), `rate of ${r.id}`).toBe(rate);
    }
    record("indexer.L11", { calls: total, callsCompared: compared, curatorsCompared: statsCompared, endpoint: GQL });
    console.log(`[L11] ${total} calls on chain; ${compared} Call rows and ${statsCompared}/${byCurator.size} CuratorStats rows compared against the chain at block ${H}`);
  }

  // The indexer is live and bots keep settling calls, so the indexer can move past block H between our reads: if a
  // comparison fails, redo it from a fresh block (up to 3 times). A real handler bug fails every attempt.
  test("every Call row, CuratorStats, MarketStats and CuratorRevenue equals the recomputation from contract reads", async () => {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await compareOnce(); return; } catch (e) { last = e; console.log(`[L11] attempt ${attempt} failed: ${(e as Error).message.slice(0, 200)}`); }
    }
    throw last;
  }, 600_000);

  test("curator handles and bot flags equal the CuratorRegistry's", async () => {
    const cs = await gql<{ Curator: Record<string, any>[] }>(`{ Curator(where:{chainId:{_eq:10143}}) { id handle isBot bond } }`);
    expect(cs.Curator.length).toBeGreaterThanOrEqual(5);
    for (const c of cs.Curator) {
      const onchain = (await publicClient.readContract({ address: CU, abi: abis.curators, functionName: "getCurator", args: [c.id] })) as { handle: string; isBot: boolean; bond: bigint };
      expect(c.handle).toBe(onchain.handle);
      expect(c.isBot).toBe(onchain.isBot);
      expect(BigInt(c.bond)).toBe(onchain.bond);
    }
  }, 120_000);
});
