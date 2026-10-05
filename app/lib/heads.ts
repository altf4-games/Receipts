"use client";
export type Stage = "Proposed" | "Voted" | "Finalized";
export const STAGES: Stage[] = ["Proposed", "Voted", "Finalized"];

const WS_URL = "wss://testnet-rpc.monad.xyz";
const seen = new Map<number, Partial<Record<Stage, number>>>(); // absolute ms timestamps per block and stage
let ws: WebSocket | null = null;
export let headsFailed = false;

/** Open Monad's monadNewHeads stream once, before any transaction is sent, so a block's stages are never missed. */
export function startHeads() {
  if (ws || typeof WebSocket === "undefined") return;
  try {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => ws!.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["monadNewHeads"] }));
    ws.onerror = () => { headsFailed = true; };
    ws.onclose = () => { ws = null; };
    ws.onmessage = (m) => {
      const h = JSON.parse(m.data)?.params?.result;
      if (!h?.number || !STAGES.includes(h.commitState)) return;
      const n = parseInt(h.number, 16);
      const rec = seen.get(n) ?? {};
      if (rec[h.commitState as Stage] === undefined) rec[h.commitState as Stage] = Date.now();
      seen.set(n, rec);
      if (seen.size > 300) seen.delete(Math.min(...seen.keys()));
    };
  } catch { headsFailed = true; }
}
export const stagesOf = (block: number) => seen.get(block) ?? {};
