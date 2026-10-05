import { redis } from "./delivery";
import type { SmTrade } from "./rankers";

/**
 * Nansen client. The free plan gives 100 credits once and 10 per day, so every response is stored in Redis with the time it
 * was fetched, pages never call Nansen on a view (they read the stored snapshot), and a hard reserve stops all calls when the
 * remaining credits (read from Nansen's own response headers) run low.
 *
 * Endpoints used:
 *   POST /api/v1/smart-money/perp-trades               Smart Money perp trades (Hyperliquid, trailing 7 days) - 5 credits
 *   POST /api/v1/profiler/address/related-wallets      who funded / deployed / is linked to a wallet (Monad mainnet) - 1 credit
 *   POST /api/v1/profiler/address/pnl-summary          realised PnL and win rate of a wallet (Monad mainnet) - credits shown in the header
 */
const BASE = "https://api.nansen.ai";
export const CREDIT_RESERVE = 12; // never spend the last credits: they cover one manual lookup during a demo
export const SM_SYMBOLS = ["BTC", "ETH", "SOL"] as const;
const SM_MAX_AGE_SECS = 20 * 3600;

export class NansenBudgetError extends Error {}

async function post<T>(path: string, body: unknown): Promise<{ data: T; cost: number; remaining: number }> {
  const key = process.env.NANSEN_API_KEY;
  if (!key) throw new Error("NANSEN_API_KEY is not set");
  const known = await redis.get<number>("nansen:remaining");
  if (known !== null && known <= CREDIT_RESERVE) throw new NansenBudgetError(`Nansen credits low (${known} left, reserve ${CREDIT_RESERVE})`);
  const res = await fetch(BASE + path, { method: "POST", headers: { apikey: key, "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const remaining = Number(res.headers.get("x-nansen-credits-remaining") ?? NaN);
  const cost = Number(res.headers.get("x-nansen-credits-cost") ?? 0);
  if (Number.isFinite(remaining)) await redis.set("nansen:remaining", remaining);
  if (!res.ok) throw new Error(`Nansen ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { data: (await res.json()) as T, cost, remaining };
}

// ---------------------------------------------------------------- Smart Money perp trades

type SmSnapshot = { fetchedAt: number; coveredFrom: number; trades: [number, 0 | 1, number, string][] }; // [ts, side (0 long, 1 short), usd, tx]
type RawTrade = { token_symbol: string; side: "Long" | "Short"; value_usd: number; block_timestamp: string; transaction_hash: string };

export async function readSmartMoney(): Promise<{ trades: SmTrade[]; coveredFrom: number; fetchedAt: number } | null> {
  const snaps = await Promise.all(SM_SYMBOLS.map((s) => redis.get<SmSnapshot>(`nansen:sm:${s}`)));
  const have = snaps.filter((s): s is SmSnapshot => !!s);
  if (have.length === 0) return null;
  const trades: SmTrade[] = [];
  SM_SYMBOLS.forEach((sym, i) => { for (const t of snaps[i]?.trades ?? []) trades.push({ ts: t[0], symbol: sym, side: t[1] === 0 ? "Long" : "Short", valueUsd: t[2] }); });
  return { trades, coveredFrom: Math.max(...have.map((s) => s.coveredFrom)), fetchedAt: Math.min(...have.map((s) => s.fetchedAt)) };
}

/** Fetch new Smart Money positions for one symbol and merge them into the stored snapshot. Costs 5 credits. */
export async function refreshSymbol(symbol: string, force = false): Promise<{ symbol: string; skipped?: string; added?: number; total?: number; remaining?: number }> {
  const now = Math.floor(Date.now() / 1000);
  const old = await redis.get<SmSnapshot>(`nansen:sm:${symbol}`);
  if (old && !force && now - old.fetchedAt < SM_MAX_AGE_SECS) return { symbol, skipped: "fresh" };
  // look back far enough to cover the gap since the last fetch, never more than Nansen's 168 h
  const lookback = old ? Math.min(168, Math.ceil((now - old.fetchedAt) / 3600) + 2) : 168;
  const { data, remaining } = await post<{ data: RawTrade[]; pagination: { is_last_page: boolean } }>("/api/v1/smart-money/perp-trades", {
    filters: { token_symbol: symbol }, lookback_hours: lookback, only_new_positions: true, pagination: { page: 1, per_page: 1000 },
  });
  if (!data.pagination.is_last_page) throw new Error(`Nansen returned more than one page for ${symbol}: not storing a partial snapshot`);
  const seen = new Set((old?.trades ?? []).map((t) => t[3]));
  const added: SmSnapshot["trades"] = [];
  for (const t of data.data) {
    if (t.token_symbol !== symbol || seen.has(t.transaction_hash)) continue;
    seen.add(t.transaction_hash);
    added.push([Math.floor(Date.parse(t.block_timestamp) / 1000), t.side === "Long" ? 0 : 1, t.value_usd, t.transaction_hash]);
  }
  const snap: SmSnapshot = { fetchedAt: now, coveredFrom: old?.coveredFrom ?? now - lookback * 3600, trades: [...(old?.trades ?? []), ...added] };
  await redis.set(`nansen:sm:${symbol}`, snap);
  return { symbol, added: added.length, total: snap.trades.length, remaining };
}

// ---------------------------------------------------------------- wallet intelligence (a curator's linked mainnet wallets)

export type WalletIntel = {
  address: string;
  fetchedAt: number;
  related: { address: string; relation: string; label: string | null }[];
  pnl: { realizedUsd: number; realizedPct: number; winRate: number; tokens: number; trades: number } | null;
};
const WALLET_MAX_AGE_SECS = 24 * 3600;

type RelatedResp = { data: { address: string; relation: string; address_label?: string | null }[] };
type PnlResp = { realized_pnl_usd: number; realized_pnl_percent: number; win_rate: number; traded_token_count: number; traded_times: number };

export async function readWallet(address: string): Promise<WalletIntel | null> {
  return redis.get<WalletIntel>(`nansen:wallet:${address.toLowerCase()}`);
}

export async function refreshWallet(address: string, force = false): Promise<WalletIntel> {
  const a = address.toLowerCase();
  const old = await readWallet(a);
  const now = Math.floor(Date.now() / 1000);
  if (old && !force && now - old.fetchedAt < WALLET_MAX_AGE_SECS) return old;
  const rel = await post<RelatedResp>("/api/v1/profiler/address/related-wallets", { wallet_address: a, chain: "monad", pagination: { page: 1, per_page: 50 } });
  let pnl: WalletIntel["pnl"] = null;
  try {
    const iso = (d: Date) => d.toISOString();
    const p = await post<PnlResp>("/api/v1/profiler/address/pnl-summary", { wallet_address: a, chain: "monad", date: { from: iso(new Date(Date.now() - 90 * 86400_000)), to: iso(new Date()) } });
    pnl = { realizedUsd: p.data.realized_pnl_usd ?? 0, realizedPct: p.data.realized_pnl_percent ?? 0, winRate: p.data.win_rate ?? 0, tokens: p.data.traded_token_count ?? 0, trades: p.data.traded_times ?? 0 };
  } catch (e) {
    if (e instanceof NansenBudgetError) throw e; // keep the related-wallets result for next time only if the PnL call is merely unavailable
  }
  const intel: WalletIntel = {
    address: a, fetchedAt: now, pnl,
    related: (rel.data.data ?? []).map((r) => ({ address: r.address.toLowerCase(), relation: r.relation, label: r.address_label || null })),
  };
  await redis.set(`nansen:wallet:${a}`, intel);
  return intel;
}
