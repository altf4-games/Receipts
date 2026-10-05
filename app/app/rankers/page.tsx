import Link from "next/link";
import { EXPLORER, RANKER_REGISTRY } from "@/lib/config";
import { leaderboardData, rankerByName } from "@/lib/leaderboard";
import { ALL_RANKERS } from "@/lib/rankers";
import { smartMoneyBoard } from "@/lib/nansenData";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rankers" };

const pct = (bps: number) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

export default async function Rankers({ searchParams }: PageProps<"/rankers">) {
  const sp = await searchParams;
  const ranker = rankerByName(typeof sp.r === "string" ? sp.r : undefined);
  let data: Awaited<ReturnType<typeof leaderboardData>> | null = null;
  let error: string | null = null;
  try { data = await leaderboardData(); } catch (e) { error = (e as Error).message.split("\n")[0] ?? "error"; }
  const sm = await smartMoneyBoard().catch(() => null);
  const rows = data ? ranker.rank(data.curators) : [];
  const receipt = data?.receipts.find((r) => r.name === ranker.name);
  return (
    <>
      <h1 className="mt-6 text-sm font-bold uppercase tracking-widest">Rankers</h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-dim)" }}>
        Anyone can rank curators. Each algorithm below is a pure function over the indexer&apos;s public data, registered on chain with the git commit it was published at, so you can rerun exactly the code that produced a ranking.
      </p>
      <nav className="mt-4 flex flex-wrap gap-2 text-sm" aria-label="Choose a ranker">
        {ALL_RANKERS.map((r) => (
          <Link key={r.name} href={`/rankers?r=${r.name}`} className="border-2 px-2 py-1" style={{ borderColor: r.name === ranker.name ? "var(--stamp-red)" : "var(--text-dim)", fontWeight: r.name === ranker.name ? 700 : 400 }}>{r.name}</Link>
        ))}
      </nav>
      <section className="mt-4 slip text-sm">
        <div className="font-bold">{ranker.name}</div>
        <p className="dim mt-1">{ranker.description}</p>
        {receipt ? (
          <p className="mt-2 break-all text-xs dim">
            Registered on chain (block {receipt.registeredBlock}) at git commit <code>{receipt.gitCommit}</code> ·{" "}
            <a className="underline" href={receipt.codeURI}>code at that commit</a> ·{" "}
            <a className="underline" href={`${EXPLORER}/address/${RANKER_REGISTRY}`}>RankerRegistry</a>
          </p>
        ) : <p className="mt-2 text-xs dim">Not registered on chain.</p>}
      </section>
      <section className="mt-4 slip text-sm" aria-label="Coin-flip check">
        <div className="font-bold">The coin-flip check</div>
        <p className="dim mt-1">
          <b>bot:coinflip</b> picks a direction by flipping a coin, so it has no skill. A ranker that puts it at the top is rewarding luck. Its real rank under each ranker, from the data above:
        </p>
        <ul className="mt-2">
          {ALL_RANKERS.map((r) => {
            const row = data ? r.rank(data.curators).find((x) => x.handle === "bot:coinflip") : undefined;
            return <li key={r.name} className="flex justify-between"><Link href={`/rankers?r=${r.name}`} className="underline">{r.name}</Link><span>{row?.rank ? `#${row.rank} of ${data?.curators.length}` : typeof row?.detail.needMore === "number" ? `unranked: needs ${row.detail.needMore} more calls` : "–"}</span></li>;
          })}
        </ul>
        <p className="mt-3 text-xs dim">
          <b>Simulation, not data</b> (seeded, <code>rankers/scripts/coinflip.ts</code>): among 30 pure coin flippers with 10 to 120 calls and 3 curators with a real edge, the share of trials where the top-ranked curator is skilled is: weak edge (58% wins, 60 calls) raw 40.7%, average per call 33.8%, luck-adjusted 46.9%; clear edge (65% wins, 100 calls) raw 99.0%, average 65.5%, luck-adjusted 92.6%. Luck adjustment mainly stops short streaks and volume from winning; with a big edge, plain summing is fine.
        </p>
      </section>
      {sm && (
        <section className="mt-4 slip text-sm" aria-label="Beats smart money">
          <div className="font-bold">Beats smart money <span className="text-xs font-normal dim">· Nansen</span></div>
          <p className="dim mt-1">
            Ranks curators by the Wilson lower bound of their win rate on calls made <i>against</i> Nansen Smart Money positioning (net long vs short value of new Hyperliquid positions in the 24 h before the commit). Following the crowd and being right is cheap; this rewards being right against it. Needs 3 settled calls against the lean. It is computed here from a stored Nansen snapshot, so it is not registered on chain like the rankers above.
          </p>
          <table className="mt-2 w-full">
            <thead><tr className="dim text-left"><th className="w-8">#</th><th>Curator</th><th className="text-right">Against: won</th><th className="text-right">With: won</th></tr></thead>
            <tbody>
              {sm.ranked.map((r) => (
                <tr key={r.id}>
                  <td>{r.rank ?? "–"}</td>
                  <td><Link href={`/c/${r.id}`} className="underline">{r.handle}</Link></td>
                  <td className="text-right">{r.detail.winsAgainst}/{r.detail.against}{r.score !== null && <span className="dim"> ({(r.score * 100).toFixed(0)}%)</span>}</td>
                  <td className="text-right">{r.detail.winsWith}/{r.detail.with}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs dim">{sm.fetchedAt ? `Nansen snapshot as of ${new Date(sm.fetchedAt * 1000).toISOString().replace("T", " ").slice(0, 16)}Z. ` : "No Nansen snapshot stored yet. "}Smart Money perp data covers Hyperliquid (Nansen has no Perpl feed), only the trailing 7 days are available, so calls sealed before I started storing it on Oct 5 are not compared.</p>
        </section>
      )}
      {error && <div role="alert" className="slip mt-4 text-sm">Could not read the indexer ({error}). Reload in a few seconds.</div>}
      {data && (
        <section className="mt-4 slip text-sm" aria-label={`${ranker.name} ranking`}>
          {rows.every((r) => r.rank === null) && <p className="mb-2">Nobody has enough closed calls for this ranker yet (it needs {ranker.minCalls}). Bots add calls every few hours; this fills in by itself.</p>}
          <table className="w-full">
            <thead><tr className="dim text-left"><th className="w-8">#</th><th>Curator</th><th className="text-right">Score</th><th className="text-right">Closed</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.rank ?? "–"}</td>
                  <td><Link href={`/c/${r.id}`} className="underline">{r.handle}</Link>{r.isBot && <span className="ml-1 border px-1 text-[10px]" style={{ borderColor: "var(--rule)" }}>BOT</span>}</td>
                  <td className="text-right">
                    {r.score === null ? <span className="dim">{typeof r.detail.needMore === "number" ? `needs ${r.detail.needMore} more` : "–"}</span> : ranker.name === "hit-rate-wilson" ? `${(r.score * 100).toFixed(1)}%` : ranker.name === "raw" ? pct(r.score) : `${pct(r.score)} / call`}
                  </td>
                  <td className="text-right">{r.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs dim">Scores are basis points over closed calls, with the −30% penalty for anything never revealed. The luck-adjusted bound needs ten closed calls: with fewer, no rule can tell skill from luck.</p>
        </section>
      )}
    </>
  );
}
