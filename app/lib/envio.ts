import { ENVIO_GRAPHQL } from "./config";

/** Minimal GraphQL client for the Envio endpoint, with a short in-memory cache (the app is read-heavy, the data moves slowly). */
const cache = new Map<string, { at: number; v: unknown }>();

export async function envio<T>(query: string, ttlMs = 10_000): Promise<T> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const res = await fetch(ENVIO_GRAPHQL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), cache: "no-store" });
  if (!res.ok) throw new Error(`Envio HTTP ${res.status}`);
  const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!j.data) throw new Error(`Envio: ${j.errors?.[0]?.message ?? "no data"}`);
  cache.set(query, { at: Date.now(), v: j.data });
  return j.data;
}

export type EnvioCall = {
  callId: number; perpId: number; status: "SEALED" | "REVEALED" | "SETTLED" | "EXPIRED" | "INVALID"; hash: string; horizonSecs: number;
  commitBlock: number; commitTime: number; horizonEnd: number; entryPNS: string; entryOracleTs: number; priceDecimals: number;
  direction: number | null; tpBps: number | null; slBps: number | null; scoreBps: number | null; flags: number | null;
  perplTrades: number; perplLongLots: string; perplShortLots: string;
  curator: { id: string; handle: string; isBot: boolean };
};

export const CALL_FIELDS = `callId perpId status hash horizonSecs commitBlock commitTime horizonEnd entryPNS entryOracleTs priceDecimals direction tpBps slBps scoreBps flags perplTrades perplLongLots perplShortLots curator { id handle isBot }`;

/** how far the indexer is behind the chain head (Monad testnet), for an honest "indexed to block N" label */
export async function indexedBlock(): Promise<{ indexed: number; head: number } | null> {
  try {
    const d = await envio<{ chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[] }>(`{ chain_metadata { chain_id latest_processed_block block_height } }`, 5_000);
    const m = d.chain_metadata.find((x) => x.chain_id === 10143);
    return m ? { indexed: m.latest_processed_block, head: m.block_height } : null;
  } catch { return null; }
}
