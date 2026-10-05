import { envio } from "./envio";
import { readWallet, type WalletIntel } from "./nansen";
import { smartMoneyFor } from "./smartMoneyView";
import { beatsSmartMoney, findClusters, type Cluster, type SmCurator } from "./rankers";

type Row = { id: string; handle: string; isBot: boolean; linkedWallets: string[]; calls: { callId: number; perpId: number; status: SmCurator["calls"][number]["status"]; scoreBps: number | null; direction: number | null; commitTime: number }[] };

async function curatorsWithCalls(): Promise<Row[]> {
  const d = await envio<{ Curator: Row[] }>(`{ Curator(where:{chainId:{_eq:10143}}) { id handle isBot linkedWallets calls { callId perpId status scoreBps direction commitTime } } }`);
  return d.Curator;
}

/** Smart Money alignment of every curator's revealed calls, ranked by "beats smart money". All from stored snapshots, no Nansen call. */
export async function smartMoneyBoard() {
  const rows = await curatorsWithCalls();
  const flat = rows.flatMap((c) => c.calls.map((x) => ({ cur: c.id, ...x })));
  const { ctx, fetchedAt } = await smartMoneyFor(flat);
  const byCur = new Map<string, SmCurator>(rows.map((c) => [c.id, { id: c.id, handle: c.handle, isBot: c.isBot, calls: [] }]));
  flat.forEach((x, i) => {
    // a sealed call has no public direction yet: it cannot be compared (and must not leak)
    byCur.get(x.cur)!.calls.push({ status: x.status, scoreBps: x.scoreBps, alignment: x.direction ? (ctx[i]?.align ?? "nodata") : "nodata" });
  });
  const curators = [...byCur.values()];
  return { ranked: beatsSmartMoney(curators), curators, fetchedAt };
}

export type CuratorNansen = {
  wallets: { address: string; intel: WalletIntel | null }[];
  cluster: Cluster | null;
  clusterNames: Record<string, string>;
};

/** Linked-wallet intelligence for one curator, and the sybil cluster they belong to (across all curators). */
export async function curatorNansen(curatorId: string): Promise<CuratorNansen> {
  const rows = await curatorsWithCalls();
  const intel = new Map<string, WalletIntel | null>();
  await Promise.all([...new Set(rows.flatMap((r) => r.linkedWallets.map((w) => w.toLowerCase())))].map(async (w) => intel.set(w, await readWallet(w).catch(() => null))));
  const cl = findClusters(rows.map((r) => ({
    id: r.id, wallets: r.linkedWallets.map((w) => w.toLowerCase()),
    related: Object.fromEntries(r.linkedWallets.map((w) => [w.toLowerCase(), (intel.get(w.toLowerCase())?.related ?? []).map((x) => ({ address: x.address, relation: x.relation }))])),
  })));
  const me = rows.find((r) => r.id === curatorId);
  return {
    wallets: (me?.linkedWallets ?? []).map((w) => ({ address: w.toLowerCase(), intel: intel.get(w.toLowerCase()) ?? null })),
    cluster: cl.find((c) => c.members.includes(curatorId)) ?? null,
    clusterNames: Object.fromEntries(rows.map((r) => [r.id, r.handle])),
  };
}
