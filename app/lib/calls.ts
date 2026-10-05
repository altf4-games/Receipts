import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { callRegistryAbi, curatorRegistryAbi } from "./abi";
import { CHAIN_ID, DEPLOYMENTS, MARKETS, RPC_URL, type DeploymentName } from "./config";

export const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// The public RPC allows ~15 requests/s: every read goes through Multicall3 (viem batches eth_call).
export const client = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL, { retryCount: 3, retryDelay: 400 }), batch: { multicall: true } });

export const STATUS = ["None", "Sealed", "Revealed", "Settled", "Expired", "Invalid"] as const;
export type Status = (typeof STATUS)[number];

export type CallView = {
  id: number;
  curator: Address;
  handle: string;
  isBot: boolean;
  market: string;
  perpId: number;
  status: Status;
  direction: "LONG" | "SHORT" | null; // only known after reveal
  tpBps: number | null;
  slBps: number | null;
  scoreBps: number | null; // only after close / expire
  flags: number;
  horizonSecs: number;
  commitBlock: bigint;
  commitTime: number;
  horizonEnd: number;
  entryOracleTs: number;
  revealBlock: bigint;
  closeBlock: bigint;
  entryPrice: string; // decimal string from the on-chain snapshot
  hash: Hex;
};

function fmtPrice(pns: bigint, decimals: number): string {
  const s = pns.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return s;
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

type Raw = Awaited<ReturnType<typeof readRaw>>;
async function readRaw(dep: DeploymentName, id: bigint) {
  return client.readContract({ address: DEPLOYMENTS[dep].callRegistry, abi: callRegistryAbi, functionName: "getCall", args: [id] });
}

const handleCache = new Map<string, { handle: string; isBot: boolean }>();
export async function curatorInfo(dep: DeploymentName, a: Address) {
  const hit = handleCache.get(dep + a);
  if (hit) return hit;
  const c = await client.readContract({ address: DEPLOYMENTS[dep].curatorRegistry, abi: curatorRegistryAbi, functionName: "getCurator", args: [a] });
  const v = { handle: c.handle, isBot: c.isBot };
  handleCache.set(dep + a, v); // handles never change
  return v;
}

async function toView(dep: DeploymentName, id: number, c: Raw): Promise<CallView> {
  const who = await curatorInfo(dep, c.curator);
  const revealed = c.status === 2 || c.status === 3;
  return {
    id,
    curator: c.curator,
    ...who,
    market: MARKETS[c.perpId] ?? `perp ${c.perpId}`,
    perpId: c.perpId,
    status: STATUS[c.status] ?? "None",
    direction: revealed ? (c.direction === 1 ? "LONG" : "SHORT") : null,
    tpBps: revealed ? c.tpBps : null,
    slBps: revealed ? c.slBps : null,
    scoreBps: c.status >= 3 ? c.scoreBps : null,
    flags: c.flags,
    horizonSecs: c.horizonSecs,
    commitBlock: c.commitBlock,
    commitTime: Number(c.commitTime),
    horizonEnd: Number(c.horizonEnd),
    entryOracleTs: Number(c.entryOracleTs),
    revealBlock: c.revealBlock,
    closeBlock: c.closeBlock,
    entryPrice: fmtPrice(c.entryPNS, c.priceDecimals),
    hash: c.hash,
  };
}

// tiny per-instance TTL cache so a busy page does not hammer the public RPC
const ttl = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = ttl.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v as T;
  const v = await fn();
  ttl.set(key, { at: Date.now(), v });
  return v;
}

export async function callCount(dep: DeploymentName = "production"): Promise<number> {
  return cached("count" + dep, 8_000, async () => Number(await client.readContract({ address: DEPLOYMENTS[dep].callRegistry, abi: callRegistryAbi, functionName: "nextCallId" })) - 1);
}

export async function getCallView(id: number, dep: DeploymentName = "production"): Promise<CallView | null> {
  const n = await callCount(dep);
  if (!Number.isInteger(id) || id < 1 || id > n) return null;
  return cached(`call:${dep}:${id}`, 8_000, async () => toView(dep, id, await readRaw(dep, BigInt(id))));
}

export async function recentCalls(limit: number, dep: DeploymentName = "production"): Promise<{ total: number; calls: CallView[] }> {
  const total = await callCount(dep);
  const ids = Array.from({ length: Math.min(limit, total) }, (_, i) => total - i);
  const calls = await Promise.all(ids.map((id) => getCallView(id, dep)));
  return { total, calls: calls.filter((c): c is CallView => c !== null) };
}
