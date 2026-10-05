"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { parseAbi, type Address, type Hex } from "viem";
import { DEPLOYMENTS, EXPLORER, type DeploymentName } from "@/lib/config";
import { FaucetButton } from "@/components/FaucetButton";
import { clients, connect, humanError, monad, useAutoConnect } from "@/lib/wallet";

const abi = parseAbi(["function claim(address[] subscribers) returns (uint256)", "function cancel(address curator) returns (uint256)"]);
type CurRow = { subscriber: Address; deposit: string; accrued: string; unclaimed: string; active: boolean; activeUntil: number };
type SubRow = { curator: Address; handle: string; deposit: string; accrued: string; refundable: string; active: boolean; activeUntil: number };
type View = { owed: string; asCurator: CurRow[]; asSubscriber: SubRow[]; cursor: number; head: number };
const ausd = (n: string | bigint) => (Number(n) / 1e6).toFixed(4);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (t: number) => new Date(t * 1000).toLocaleString();

export function Me({ dep }: { dep: DeploymentName }) {
  const [acct, setAcct] = useState<Address | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txs, setTxs] = useState<Hex[]>([]);

  const load = useCallback(async (a: Address) => {
    // the server scans events incrementally (public RPC allows 100 blocks per getLogs); ask again until it has caught up
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`/api/account?address=${a}&deployment=${dep}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      setView(b);
      if (b.cursor >= b.head - 200) break;
    }
  }, [dep]);

  useEffect(() => { if (acct) load(acct).catch((e) => setError(humanError(e))); }, [acct, load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(humanError(e)); } finally { setBusy(null); }
  };
  const write = async (functionName: "claim" | "cancel", args: unknown[]) => {
    const { pub, wallet } = clients(acct!);
    const hash = await wallet.writeContract({ address: DEPLOYMENTS[dep].subscriptions, abi, functionName, args, account: acct!, chain: monad } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    setTxs((t) => [...t, hash]);
    if (r.status !== "success") throw new Error("The transaction reverted.");
    await load(acct!);
  };

  useAutoConnect(() => run("Connecting", async () => setAcct(await connect())), () => { setAcct(null); setView(null); });

  const btn = "border-2 px-3 py-2 font-bold disabled:opacity-50";
  const claimable = view ? BigInt(view.owed) + view.asCurator.reduce((n, r) => n + BigInt(r.unclaimed), BigInt(0)) : BigInt(0);

  return (
    <div className="mt-4 flex flex-col gap-6">
      {!acct ? (
        <section className="slip text-sm">
          <div className="font-bold">Your earnings and subscriptions</div>
          <button className={`${btn} mt-3`} style={{ borderColor: "var(--paper-ink)" }} disabled={!!busy}
            onClick={() => run("Connecting", async () => setAcct(await connect()))}>{busy ?? "Connect wallet"}</button>
        </section>
      ) : (
        <>
          <section className="slip text-sm">
            <div className="dim break-all">Connected {acct}</div>
            <div className="mt-2"><FaucetButton account={acct} onDone={() => load(acct)} /></div>
            <hr />
            <div className="font-bold">Earnings as a curator</div>
            {!view ? <p className="dim">Loading…</p> : view.asCurator.length === 0 && view.owed === "0" ? (
              <p className="dim">No subscribers yet.</p>
            ) : (
              <>
                <div className="mt-1">Ready to claim: <b>${ausd(claimable)}</b></div>
                <ul className="mt-2 flex flex-col gap-1">
                  {view.asCurator.map((r) => (
                    <li key={r.subscriber} className="flex justify-between gap-2">
                      <span>{short(r.subscriber)} · {r.active ? `until ${when(r.activeUntil)}` : "ended"}</span>
                      <span>{ausd(r.accrued)} of {ausd(r.deposit)}</span>
                    </li>
                  ))}
                </ul>
                <button className={`${btn} mt-3`} style={{ borderColor: "var(--stamp-green)", color: "var(--stamp-green)" }}
                  disabled={!!busy || claimable === BigInt(0)}
                  onClick={() => run("Claiming", () => write("claim", [view.asCurator.map((r) => r.subscriber)]))}>
                  {busy === "Claiming" ? "Claiming…" : `Claim $${ausd(claimable)}`}
                </button>
              </>
            )}
          </section>
          <section className="slip text-sm">
            <div className="font-bold">Your subscriptions</div>
            {!view ? <p className="dim">Loading…</p> : view.asSubscriber.length === 0 ? <p className="dim">You are not subscribed to anyone.</p> : (
              <ul className="mt-2 flex flex-col gap-3">
                {view.asSubscriber.map((r) => (
                  <li key={r.curator} className="flex items-center justify-between gap-2">
                    <span>{r.handle}<br /><span className="dim">{r.active ? `until ${when(r.activeUntil)}` : "ended"} · refundable ${ausd(r.refundable)}</span></span>
                    <button className={btn} style={{ borderColor: "var(--paper-ink)" }} disabled={!!busy}
                      onClick={() => run("Cancelling", () => write("cancel", [r.curator]))}>Cancel</button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 dim">Cancelling refunds exactly what has not been earned yet.</p>
          </section>
        </>
      )}
      {busy && <div className="dim text-sm">{busy}… confirm in your wallet if asked.</div>}
      {error && <div role="alert" className="text-sm" style={{ color: "var(--stamp-red)" }}>{error}</div>}
      {txs.map((t) => <div key={t} className="break-all text-xs dim"><a className="underline" href={`${EXPLORER}/tx/${t}`}>tx {t}</a></div>)}
      <Link href="/new" className="text-sm underline">Publish a call →</Link>
    </div>
  );
}
