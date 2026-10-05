import Link from "next/link";
import { notFound } from "next/navigation";
import { Receipt } from "@/components/Receipt";
import { CALL_FIELDS, envio, type EnvioCall } from "@/lib/envio";
import { toCallView } from "@/lib/envioCalls";
import { ALL_RANKERS } from "@/lib/rankers";
import { leaderboardData } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

type Stats = { calls: number; settled: number; expired: number; invalid: number; wins: number; losses: number; sumScoreBps: number; bestBps: number; worstBps: number; equityBps: number; maxDrawdownBps: number };
const pct = (bps: number) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

export default async function CuratorPage({ params }: PageProps<"/c/[id]">) {
  const key = decodeURIComponent((await params).id).toLowerCase();
  if (!/^(0x[0-9a-f]{40}|[a-z0-9_:-]{3,32})$/.test(key)) notFound();
  const where = key.startsWith("0x") ? `id:{_eq:"${key}"}` : `handle:{_eq:"${key}"}`;
  const d = await envio<{
    Curator: { id: string; handle: string; isBot: boolean; bond: string; registeredAt: number; linkedWallets: string[]; perplAccountId: string | null }[];
  }>(`{ Curator(where:{chainId:{_eq:10143}, ${where}}) { id handle isBot bond registeredAt linkedWallets perplAccountId } }`);
  const cur = d.Curator[0];
  if (!cur) notFound();
  const more = await envio<{ CuratorStats: Stats[]; CuratorRevenue: { rate: string; subscribers: number; totalDeposited: string; claimed: string }[]; Call: EnvioCall[] }>(
    `{ CuratorStats(where:{id:{_eq:"${cur.id}"}}) { calls settled expired invalid wins losses sumScoreBps bestBps worstBps equityBps maxDrawdownBps }
       CuratorRevenue(where:{id:{_eq:"${cur.id}"}}) { rate subscribers totalDeposited claimed }
       Call(where:{curator_id:{_eq:"${cur.id}"}}, order_by:{callId:desc}, limit:10) { ${CALL_FIELDS} } }`,
  );
  const s = more.CuratorStats[0];
  const rev = more.CuratorRevenue[0];
  const lb = await leaderboardData().catch(() => null);
  const ranks = lb ? ALL_RANKERS.map((r) => ({ name: r.name, row: r.rank(lb.curators).find((x) => x.id === cur.id) })) : [];
  const skin = more.Call.filter((c) => c.perplTrades > 0);
  return (
    <>
      <Link href="/rankers" className="mt-4 inline-block text-sm underline">← rankers</Link>
      <section className="mt-4 slip text-sm">
        <div className="text-lg font-bold">{cur.handle}{cur.isBot && <span className="ml-2 border px-1 text-xs" style={{ borderColor: "var(--rule)" }}>BOT</span>}</div>
        <div className="break-all text-xs dim">{cur.id}</div>
        {cur.isBot && <p className="mt-2 dim">A labelled algorithmic curator run by the author. Its calls are real transactions on real oracle prices.</p>}
        <hr />
        {s ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="dim">Calls</dt><dd className="text-right">{s.calls} ({s.settled} settled, {s.expired} never revealed, {s.invalid} invalid)</dd>
            <dt className="dim">Wins / losses</dt><dd className="text-right">{s.wins} / {s.losses}</dd>
            <dt className="dim">Total score</dt><dd className="text-right">{pct(s.sumScoreBps)}</dd>
            <dt className="dim">Best / worst call</dt><dd className="text-right">{pct(s.bestBps)} / {pct(s.worstBps)}</dd>
            <dt className="dim">Max drawdown</dt><dd className="text-right">{(s.maxDrawdownBps / 100).toFixed(2)}%</dd>
          </dl>
        ) : <p className="dim">No scored calls yet.</p>}
        {rev && rev.rate !== "0" && <p className="mt-3">Sells subscriptions at {(Number(rev.rate) * 3600 / 1e6).toFixed(2)} AUSD per hour · {rev.subscribers} subscribers so far.</p>}
        {cur.perplAccountId && <p className="mt-2 dim">Perpl account #{cur.perplAccountId} linked.{skin.length ? ` Opened Perpl positions while ${skin.length} of the calls below were open.` : " No Perpl positions opened while a call was open."}</p>}
      </section>
      {ranks.length > 0 && (
        <section className="mt-4 slip text-sm">
          <div className="font-bold">Rank by ranker</div>
          <ul className="mt-1">{ranks.map(({ name, row }) => (
            <li key={name} className="flex justify-between"><Link href={`/rankers?r=${name}`} className="underline">{name}</Link><span>{row?.rank ? `#${row.rank}` : typeof row?.detail.needMore === "number" ? `needs ${row.detail.needMore} more calls` : "–"}</span></li>
          ))}</ul>
        </section>
      )}
      <h2 className="mt-6 mb-3 text-sm font-bold uppercase tracking-widest">Latest calls</h2>
      <div className="flex flex-col gap-6">{more.Call.map((c) => <Receipt key={c.callId} c={toCallView(c)} />)}</div>
    </>
  );
}
