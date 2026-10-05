import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Receipt } from "@/components/Receipt";
import { recentCalls } from "@/lib/calls";
import type { CallView } from "@/lib/calls";
import { indexedBlock } from "@/lib/envio";
import { latestCalls } from "@/lib/envioCalls";
import { leaderboardData, rankerByName } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

async function load(): Promise<{ calls: CallView[]; total: number; source: "envio" | "chain"; error: string | null }> {
  try {
    const { calls, total } = await latestCalls(12);
    return { calls, total, source: "envio", error: null };
  } catch (e) {
    // the indexer being down must not take the feed down: fall back to reading the chain directly
    try {
      const d = await recentCalls(12);
      return { calls: d.calls, total: d.total, source: "chain", error: null };
    } catch (e2) {
      return { calls: [], total: 0, source: "chain", error: (e2 as Error).message.split("\n")[0] ?? String(e) };
    }
  }
}

export default async function Home() {
  const [feed, lb, lag] = await Promise.all([load(), leaderboardData().catch(() => null), indexedBlock()]);
  const ranker = rankerByName("raw");
  const top = lb ? ranker.rank(lb.curators).filter((r) => r.rank !== null).slice(0, 5) : [];
  return (
    <>
      <p className="mt-4 text-sm" style={{ color: "var(--text-dim)" }}>
        Finfluencers delete their bad calls. On Receipts, they can&apos;t. Every call is sealed on Monad with Perpl&apos;s
        oracle price snapshotted in the same transaction; a call that is never revealed scores −30%.
      </p>
      {top.length > 0 && (
        <section className="mt-6 slip text-sm" aria-label="Leaderboard">
          <div className="flex justify-between"><span className="font-bold">Leaderboard · {ranker.name}</span><Link href="/rankers" className="underline">all rankers →</Link></div>
          <ol className="mt-2 flex flex-col gap-1">
            {top.map((r) => (
              <li key={r.id} className="flex justify-between gap-2">
                <span>{r.rank}. <Link href={`/c/${r.id}`} className="underline">{r.handle}</Link>{r.isBot && <span className="ml-1 border px-1 text-[10px]" style={{ borderColor: "var(--rule)" }}>BOT</span>}</span>
                <span>{(r.score! / 100).toFixed(2)}% over {r.n} calls</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="mt-6 mb-3 flex flex-wrap items-baseline justify-between gap-2"><h1 className="text-sm font-bold uppercase tracking-widest">Latest receipts · {feed.total} sealed so far</h1><LiveRefresh /></div>
      {feed.error && <div role="alert" className="slip text-sm">Could not read the data right now ({feed.error}). Reload in a few seconds.</div>}
      {!feed.error && feed.calls.length === 0 && <div className="slip text-sm">No calls yet.</div>}
      <div className="flex flex-col gap-6">{feed.calls.map((c) => <Receipt key={c.id} c={c} />)}</div>
      <p className="mt-6 text-xs" style={{ color: "var(--text-dim)" }}>
        {feed.source === "envio" ? "Indexed by Envio HyperIndex" : "Read straight from the chain (the indexer is unavailable)"}
        {lag && feed.source === "envio" ? ` · indexed to block ${lag.indexed.toLocaleString()} of ${lag.head.toLocaleString()}` : ""}
      </p>
    </>
  );
}
