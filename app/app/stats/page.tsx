import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { getStats } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stats", description: "Live numbers from the Envio index of Receipts on Monad testnet." };

const ausd = (u: string) => `$${(Number(u) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const when = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";

export default async function StatsPage() {
  let s: Awaited<ReturnType<typeof getStats>> | null = null;
  let error: string | null = null;
  try { s = await getStats(); } catch (e) { error = (e as Error).message.split("\n")[0] ?? "error"; }
  return (
    <>
      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-sm font-bold uppercase tracking-widest">Stats</h1>
        <LiveRefresh seconds={30} />
      </div>
      <p className="mt-2 text-sm" style={{ color: "var(--text-dim)" }}>
        Live counts of everything on Monad testnet, read from the Envio index. Bots are labelled and run by the author; five of their calls (#48 to #52) were never revealed because my free keeper host was down, so they carry the -30% penalty for good.
      </p>
      {error && <div role="alert" className="slip mt-4 text-sm">Could not read the indexer ({error}). Reload in a few seconds.</div>}
      {s && (
        <>
          <section className="slip mt-4 text-sm" aria-label="Calls">
            <div className="font-bold">Calls</div>
            <hr />
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="dim">Sealed on chain</dt><dd className="text-right">{s.calls}</dd>
              <dt className="dim">Still hidden</dt><dd className="text-right">{s.sealed}</dd>
              <dt className="dim">Revealed, not yet settled</dt><dd className="text-right">{s.revealed}</dd>
              <dt className="dim">Settled</dt><dd className="text-right">{s.settled}</dd>
              <dt className="dim">Never revealed (-30%)</dt><dd className="text-right">{s.expired}</dd>
              <dt className="dim">Invalid reveals</dt><dd className="text-right">{s.invalid}</dd>
              <dt className="dim">Scored from the price tape (SettlerV2)</dt><dd className="text-right">{s.viaTape}</dd>
              <dt className="dim">Scored late (endpoint over 3 min after the horizon)</dt><dd className="text-right">{s.late}</dd>
              <dt className="dim">Disputed</dt><dd className="text-right">{s.disputed}</dd>
              <dt className="dim">Curator opened a Perpl position while the call was open</dt><dd className="text-right">{s.perplTradesFlagged}</dd>
            </dl>
            {s.firstCall && s.lastCall && <p className="mt-3 text-xs dim">First call sealed {when(s.firstCall)}, latest {when(s.lastCall)}.</p>}
          </section>
          <section className="slip mt-4 text-sm" aria-label="Markets and price tape">
            <div className="font-bold">Markets and the price tape</div>
            <hr />
            <table className="w-full">
              <thead><tr className="dim text-left"><th>Market</th><th className="text-right">Calls</th><th className="text-right">Tape samples</th></tr></thead>
              <tbody>{s.markets.map((m) => <tr key={m.perpId}><td>{m.name}</td><td className="text-right">{m.calls}</td><td className="text-right">{m.tapeSamples}</td></tr>)}</tbody>
            </table>
            <p className="mt-3 text-xs dim">{s.tapeSamples} oracle samples recorded on chain in total. Each one is the Perpl oracle price read inside the transaction that stored it.</p>
          </section>
          <section className="slip mt-4 text-sm" aria-label="People and money">
            <div className="font-bold">Curators, subscriptions and rankers</div>
            <hr />
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="dim">Curators</dt><dd className="text-right">{s.curators} ({s.bots} labelled bots, {s.humans} human)</dd>
              <dt className="dim">Subscription streams opened</dt><dd className="text-right">{s.streams}</dd>
              <dt className="dim">Deposited (test dollars)</dt><dd className="text-right">{ausd(s.deposited)}</dd>
              <dt className="dim">Refunded on cancel</dt><dd className="text-right">{ausd(s.refunded)}</dd>
              <dt className="dim">Open rankers registered on chain</dt><dd className="text-right"><Link href="/rankers" className="underline">{s.rankers}</Link></dd>
            </dl>
          </section>
          <p className="mt-4 text-xs" style={{ color: "var(--text-dim)" }}>
            Indexed by Envio HyperIndex{s.indexed ? ` · block ${s.indexed.indexed.toLocaleString()} of ${s.indexed.head.toLocaleString()}` : ""}. Test money only.
          </p>
        </>
      )}
    </>
  );
}
