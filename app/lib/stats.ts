import { envio, indexedBlock } from "./envio";
import { MARKETS } from "./config";

export type Stats = {
  calls: number; sealed: number; revealed: number; settled: number; expired: number; invalid: number;
  viaTape: number; disputed: number; late: number;
  curators: number; bots: number; humans: number;
  markets: { perpId: number; name: string; calls: number; tapeSamples: number; lastOraclePrice: string | null; lastOracleTs: number | null }[];
  tapeSamples: number;
  streams: number; deposited: string; refunded: string;
  rankers: number;
  perplTradesFlagged: number;
  firstCall: number | null; lastCall: number | null;
  indexed: { indexed: number; head: number } | null;
};

/** Everything on /stats comes from the Envio index (all counts are of real rows); nothing is typed in. */
export async function getStats(): Promise<Stats> {
  const d = await envio<{
    Call: { callId: number; status: string; flags: number | null; pathScored: boolean; disputed: boolean; commitTime: number; perplTrades: number }[];
    Curator: { isBot: boolean }[];
    MarketStats: { perpId: number; calls: number; tapeSamples: number; lastOraclePrice: string | null; lastOracleTs: number | null }[];
    Subscription: { totalDeposited: string; totalRefunded: string }[];
    Ranker: { id: string }[];
  }>(`{
    Call(where:{chainId:{_eq:10143}}, limit:5000) { callId status flags pathScored disputed commitTime perplTrades }
    Curator(where:{chainId:{_eq:10143}}) { isBot }
    MarketStats(where:{chainId:{_eq:10143}}) { perpId calls tapeSamples lastOraclePrice lastOracleTs }
    Subscription(limit:5000) { totalDeposited totalRefunded }
    Ranker { id }
  }`, 15_000);
  const n = (s: string) => d.Call.filter((c) => c.status === s).length;
  const times = d.Call.map((c) => c.commitTime);
  return {
    calls: d.Call.length, sealed: n("SEALED"), revealed: n("REVEALED"), settled: n("SETTLED"), expired: n("EXPIRED"), invalid: n("INVALID"),
    viaTape: d.Call.filter((c) => c.pathScored).length,
    disputed: d.Call.filter((c) => c.disputed).length,
    late: d.Call.filter((c) => ((c.flags ?? 0) & 2) !== 0).length,
    curators: d.Curator.length, bots: d.Curator.filter((c) => c.isBot).length, humans: d.Curator.filter((c) => !c.isBot).length,
    markets: d.MarketStats.map((m) => ({ perpId: m.perpId, name: MARKETS[m.perpId] ?? `perp ${m.perpId}`, calls: m.calls, tapeSamples: m.tapeSamples, lastOraclePrice: m.lastOraclePrice, lastOracleTs: m.lastOracleTs })).sort((a, b) => b.calls - a.calls),
    tapeSamples: d.MarketStats.reduce((s, m) => s + m.tapeSamples, 0),
    streams: d.Subscription.length,
    deposited: d.Subscription.reduce((s, x) => s + BigInt(x.totalDeposited), BigInt(0)).toString(),
    refunded: d.Subscription.reduce((s, x) => s + BigInt(x.totalRefunded), BigInt(0)).toString(),
    rankers: d.Ranker.length,
    perplTradesFlagged: d.Call.filter((c) => c.perplTrades > 0).length,
    firstCall: times.length ? Math.min(...times) : null, lastCall: times.length ? Math.max(...times) : null,
    indexed: await indexedBlock(),
  };
}
