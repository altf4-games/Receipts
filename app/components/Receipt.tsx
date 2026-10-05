import Link from "next/link";
import { EXPLORER, ADDR } from "@/lib/config";
import type { CallView } from "@/lib/calls";

const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
const dur = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
const when = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";

function Stamp({ c }: { c: CallView }) {
  if (c.status === "Sealed") return <span className="stamp" style={{ color: "var(--stamp-red)" }}>Sealed</span>;
  if (c.status === "Revealed") return <span className="stamp" style={{ color: "var(--stamp-grey)" }}>Revealed</span>;
  if (c.status === "Settled") {
    const s = c.scoreBps ?? 0;
    return <span className="stamp" style={{ color: s >= 0 ? "var(--stamp-green)" : "var(--stamp-red)" }}>{pct(s)} Settled</span>;
  }
  if (c.status === "Expired") return <span className="stamp" style={{ color: "var(--stamp-red)" }}>Expired {pct(c.scoreBps ?? 0)}</span>;
  return <span className="stamp" style={{ color: "var(--stamp-red)" }}>Invalid {pct(c.scoreBps ?? 0)}</span>;
}

export function Receipt({ c, link = true }: { c: CallView; link?: boolean }) {
  const heading = <div className="text-lg font-bold">#{c.id} · {c.market}{c.direction ? ` ${c.direction}` : ""}</div>;
  const title = (
    <div className="flex items-start justify-between gap-3">
      <div>
        {link ? <Link href={`/call/${c.id}`} className="block">{heading}</Link> : heading}
        <div className="text-xs dim">
          <Link href={`/c/${c.curator.toLowerCase()}`} className="underline">{c.handle}</Link>
          {c.isBot && <span className="ml-1 border px-1" style={{ borderColor: "var(--rule)" }}>BOT</span>}
        </div>
      </div>
      <Stamp c={c} />
    </div>
  );
  return (
    <article className="slip slip-in" aria-label={`Call ${c.id}`}>
      {title}
      <hr />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="dim">Entry (oracle)</dt><dd className="text-right">{c.entryPrice}</dd>
        <dt className="dim">Sealed at</dt><dd className="text-right">{when(c.commitTime)}</dd>
        <dt className="dim">Block</dt><dd className="text-right">{c.commitBlock.toString()}</dd>
        <dt className="dim">Horizon</dt><dd className="text-right">{dur(c.horizonSecs)}</dd>
        {c.tpBps !== null && <><dt className="dim">Take profit</dt><dd className="text-right">{pct(c.tpBps)}</dd></>}
        {c.slBps !== null && <><dt className="dim">Stop loss</dt><dd className="text-right">{pct(-c.slBps)}</dd></>}
        {c.status === "Sealed" && <><dt className="dim">Call</dt><dd className="text-right">hidden until revealed</dd></>}
      </dl>
      <hr />
      <div className="barcode" aria-hidden />
      <div className="mt-1 break-all text-[10px] dim">hash {c.hash}</div>
      {!link && (
        <div className="mt-3 text-xs dim">
          <a className="underline" href={`${EXPLORER}/address/${ADDR.callRegistry}`}>CallRegistry</a> ·{" "}
          <a className="underline" href={`${EXPLORER}/block/${c.commitBlock}`}>commit block</a>
        </div>
      )}
    </article>
  );
}
