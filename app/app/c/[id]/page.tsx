import Link from "next/link";
import { notFound } from "next/navigation";
import { Receipt } from "@/components/Receipt";
import { CALL_FIELDS, envio, type EnvioCall } from "@/lib/envio";
import { toCallView } from "@/lib/envioCalls";
import { ALL_RANKERS } from "@/lib/rankers";
import { curatorNansen, smartMoneyBoard } from "@/lib/nansenData";
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
  const nan = await curatorNansen(cur.id).catch(() => null);
  const smb = await smartMoneyBoard().catch(() => null);
  const mine = smb?.curators.find((x) => x.id === cur.id)?.calls ?? [];
  const tally = (a: string) => mine.filter((x) => x.alignment === a && x.status === "SETTLED");
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
        {rev && rev.rate !== "0" && <p className="mt-3">Sells subscriptions at ${(Number(rev.rate) * 3600 / 1e6).toFixed(2)} per hour · {rev.subscribers} subscribers so far.</p>}
        {cur.perplAccountId && <p className="mt-2 dim">Perpl account #{cur.perplAccountId} linked.{skin.length ? ` Opened Perpl positions while ${skin.length} of the calls below were open.` : " No Perpl positions opened while a call was open."}</p>}
      </section>
      <section className="mt-4 slip text-sm" aria-label="Nansen intelligence">
        <div className="font-bold">Nansen intelligence</div>
        <hr />
        <p>
          Smart Money alignment of settled calls: <b>{tally("against").length}</b> against the lean ({tally("against").filter((x) => (x.scoreBps ?? 0) > 0).length} won), <b>{tally("with").length}</b> with it ({tally("with").filter((x) => (x.scoreBps ?? 0) > 0).length} won), {mine.filter((x) => x.status === "SETTLED" && (x.alignment === "neutral" || x.alignment === "nodata")).length} with no clear lean or no stored data.
        </p>
        {nan && nan.cluster && (
          <div role="note" className="mt-3 border-2 p-2" style={{ borderColor: "var(--stamp-red)" }}>
            <b>Possible same-operator cluster:</b> {nan.cluster.members.map((m) => nan.clusterNames[m] ?? m).join(", ")}. Nansen links their identity wallets:
            <ul className="mt-1 list-disc pl-5">{nan.cluster.reasons.map((r, i) => <li key={i}>{nan.clusterNames[r.a]} and {nan.clusterNames[r.b]}: {r.why}</li>)}</ul>
            <p className="mt-1 text-xs dim">A flag, not a ban: it tells subscribers these curators may be one operator.</p>
          </div>
        )}
        {nan && nan.wallets.length > 0 ? nan.wallets.map((w) => (
          <div key={w.address} className="mt-3">
            <div className="break-all text-xs dim">Linked mainnet wallet {w.address}</div>
            {w.intel ? (
              <>
                <p>
                  {w.intel.pnl && w.intel.pnl.trades === 0 ? "Nansen sees no trades from this wallet on Monad mainnet in the last 90 days." : w.intel.pnl ? `Realised PnL on Monad mainnet, last 90 days: ${w.intel.pnl.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(w.intel.pnl.realizedUsd).toFixed(2)} (${(w.intel.pnl.winRate * 100).toFixed(0)}% win rate over ${w.intel.pnl.trades} trades in ${w.intel.pnl.tokens} tokens).` : "No PnL data from Nansen for this wallet."}{" "}
                  {w.intel.related.length ? `${w.intel.related.length} related wallet${w.intel.related.length === 1 ? "" : "s"} (${[...new Set(w.intel.related.map((r) => r.relation))].join(", ")}).` : "No related wallets found."}
                </p>
                <p className="text-xs dim">Nansen data as of {new Date(w.intel.fetchedAt * 1000).toISOString().replace("T", " ").slice(0, 16)}Z.</p>
              </>
            ) : <p className="dim">Not fetched yet: the daily refresh picks up new links.</p>}
          </div>
        )) : <p className="mt-3 dim">No mainnet identity wallet linked. Linking one (signed by that wallet, so it cannot be claimed by someone else) lets Nansen show this curator&apos;s real trading record and detect clusters of curators run by one operator.</p>}
        <p className="mt-3 text-xs dim">Nansen has no testnet data: it reads the linked wallets on Monad mainnet. Smart Money perp trades are Hyperliquid.</p>
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
