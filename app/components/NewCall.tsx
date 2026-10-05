"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { parseAbi, toHex, type Address, type Hex } from "viem";
import { callRegistryAbi, erc20Abi, subscriptionsAbi } from "@/lib/abi";
import { DEPLOYMENTS, EXPLORER, MARKETS, type DeploymentName } from "@/lib/config";
import { hashPlain, type Plain } from "@/lib/hash";
import { clients, connect, humanError, monad } from "@/lib/wallet";

const curatorAbi = parseAbi([
  "function register(string handle, string metadataURI, bool isBot, uint256 bondAmount)",
  "function getCurator(address) view returns ((string handle, string metadataURI, bool isBot, bool registered, uint128 bond, uint64 withdrawAfter))",
  "function minBond() view returns (uint256)",
]);
const registryExtra = parseAbi([
  "function openCallId(address curator, uint256 perpId) view returns (uint256)",
  "function commit(uint256 perpId, bytes32 hash, uint32 horizonSecs) returns (uint256)",
  "function reveal(uint256 callId, uint8 direction, uint16 tpBps, uint16 slBps, bytes32 salt)",
]);
const setRateAbi = parseAbi(["function setRate(uint128 newRate)"]);

type Saved = { callId: number; plain: Plain; revealed?: boolean };
const lsKey = (dep: string, acct: string) => `receipts:calls:${dep}:${acct.toLowerCase()}`;
const readSaved = (dep: string, acct: string): Saved[] => {
  try { return JSON.parse(localStorage.getItem(lsKey(dep, acct)) ?? "[]"); } catch { return []; }
};
const writeSaved = (dep: string, acct: string, v: Saved[]) => {
  try { localStorage.setItem(lsKey(dep, acct), JSON.stringify(v)); } catch { /* storage can be unavailable; the server copy remains */ }
};
const ausd = (n: bigint) => (Number(n) / 1e6).toFixed(2);

export function NewCall({ dep }: { dep: DeploymentName }) {
  const A = DEPLOYMENTS[dep];
  const [acct, setAcct] = useState<Address | null>(null);
  const [bal, setBal] = useState<bigint>(BigInt(0));
  const [minBond, setMinBond] = useState<bigint>(BigInt(50_000_000));
  const [handle, setHandle] = useState<string | null>(null);
  const [rate, setRate] = useState<bigint>(BigInt(0));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txs, setTxs] = useState<Hex[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  // form
  const [newHandle, setNewHandle] = useState("");
  const [price, setPrice] = useState("5");
  const [perp, setPerp] = useState("16");
  const [dir, setDir] = useState<1 | 2>(1);
  const [tp, setTp] = useState("2");
  const [sl, setSl] = useState("1");
  const [horizonMin, setHorizonMin] = useState("60");

  const load = useCallback(async (a: Address) => {
    const { pub } = clients();
    const [b, c, r, mb] = await Promise.all([
      pub.readContract({ address: A.ausd, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
      pub.readContract({ address: A.curatorRegistry, abi: curatorAbi, functionName: "getCurator", args: [a] }),
      pub.readContract({ address: A.subscriptions, abi: subscriptionsAbi, functionName: "ratePerSec", args: [a] }),
      pub.readContract({ address: A.curatorRegistry, abi: curatorAbi, functionName: "minBond" }),
    ]);
    setBal(b); setRate(r); setMinBond(mb);
    setHandle(c.registered ? c.handle : null);
    setSaved(readSaved(dep, a));
  }, [A, dep]);

  useEffect(() => { if (acct) load(acct).catch((e) => setError(humanError(e))); }, [acct, load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(humanError(e)); } finally { setBusy(null); }
  };
  const send = async (address: Address, abi: unknown, functionName: string, args: unknown[]) => {
    const { pub, wallet } = clients(acct!);
    const hash = await wallet.writeContract({ address, abi, functionName, args, account: acct!, chain: monad } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    setTxs((t) => [...t, hash]);
    if (r.status !== "success") throw new Error("The transaction reverted.");
    return hash;
  };

  const onConnect = () => run("Connecting", async () => setAcct(await connect()));

  const onRegister = () => run("Registering", async () => {
    const h = newHandle.trim();
    if (!/^[a-z0-9_:-]{3,32}$/.test(h) || h.startsWith("bot:")) throw new Error("Handle: 3 to 32 characters of a-z, 0-9, _ or -. The bot: prefix is reserved for labelled bots.");
    const { pub } = clients();
    if (bal < minBond) throw new Error("transfer amount exceeds balance");
    const allowance = await pub.readContract({ address: A.ausd, abi: erc20Abi, functionName: "allowance", args: [acct!, A.curatorRegistry] });
    if (allowance < minBond) { setBusy("Approving bond (1 of 2)"); await send(A.ausd, erc20Abi, "approve", [A.curatorRegistry, minBond]); }
    setBusy("Registering (2 of 2)");
    await send(A.curatorRegistry, curatorAbi, "register", [h, "", false, minBond]);
    await load(acct!);
  });

  const onRate = () => run("Setting price", async () => {
    const perHour = Number(price);
    if (!(perHour >= 0) || perHour > 100000) throw new Error("Enter a price between 0 and 100000 AUSD per hour.");
    const perSec = BigInt(Math.round((perHour * 1e6) / 3600));
    await send(A.subscriptions, setRateAbi, "setRate", [perSec]);
    await load(acct!);
  });

  const onSeal = () => run("Sealing", async () => {
    const tpBps = Math.round(Number(tp) * 100), slBps = Math.round(Number(sl) * 100), mins = Math.round(Number(horizonMin));
    if (!(tpBps > 0 && tpBps <= 3000)) throw new Error("Take profit must be above 0% and at most 30%.");
    if (!(slBps > 0 && slBps <= 1500)) throw new Error("Stop loss must be above 0% and at most 15%. A stop loss is mandatory.");
    if (!(mins >= 15 && mins <= 7 * 24 * 60)) throw new Error("Horizon must be between 15 minutes and 7 days.");
    const { pub } = clients();
    const open = await pub.readContract({ address: A.callRegistry, abi: registryExtra, functionName: "openCallId", args: [acct!, BigInt(perp)] });
    if (open !== BigInt(0)) throw new Error(`You already have an open call on this market (#${open}). Reveal and settle it first.`);
    const plain: Plain = { perpId: Number(perp), direction: dir, tpBps, slBps, horizonSecs: mins * 60, salt: toHex(crypto.getRandomValues(new Uint8Array(32))) };
    const hash = hashPlain(A.callRegistry, acct!, plain);
    // keep the secret BEFORE sending: if the tab dies after the tx, the call can still be revealed
    const pending: Saved = { callId: 0, plain };
    writeSaved(dep, acct!, [...readSaved(dep, acct!), pending]);
    await send(A.callRegistry, registryExtra, "commit", [BigInt(perp), hash, plain.horizonSecs]);
    const id = Number(await pub.readContract({ address: A.callRegistry, abi: registryExtra, functionName: "openCallId", args: [acct!, BigInt(perp)] }));
    writeSaved(dep, acct!, readSaved(dep, acct!).map((s) => (s === pending || (s.callId === 0 && s.plain.salt === plain.salt) ? { ...s, callId: id } : s)));
    const up = await fetch(`/api/calls?deployment=${dep}`, { method: "POST", body: JSON.stringify({ callId: id, ...plain }) });
    if (!up.ok) throw new Error(`Sealed on-chain as #${id}, but the delivery upload failed (${up.status}). Your browser still holds the secret; reload and retry.`);
    setSaved(readSaved(dep, acct!));
  });

  const onReveal = (s: Saved) => run("Revealing", async () => {
    await send(A.callRegistry, registryExtra, "reveal", [BigInt(s.callId), s.plain.direction, s.plain.tpBps, s.plain.slBps, s.plain.salt]);
    writeSaved(dep, acct!, readSaved(dep, acct!).map((x) => (x.callId === s.callId ? { ...x, revealed: true } : x)));
    setSaved(readSaved(dep, acct!));
  });

  const onResend = (s: Saved) => run("Uploading", async () => {
    const up = await fetch(`/api/calls?deployment=${dep}`, { method: "POST", body: JSON.stringify({ callId: s.callId, ...s.plain }) });
    if (!up.ok) throw new Error(`Delivery upload failed (${up.status}).`);
  });

  const btn = "border-2 px-3 py-2 font-bold disabled:opacity-50";
  const field = "w-full border-2 bg-transparent px-2 py-1";
  const lab = "flex flex-col gap-1";

  return (
    <div className="mt-4 flex flex-col gap-6">
      {!acct ? (
        <section className="slip text-sm">
          <div className="font-bold">Publish a call that cannot be deleted</div>
          <p className="dim mt-1">You seal a call as a hash. Perpl&apos;s oracle price is snapshotted in the same transaction. Never revealing it scores −30%.</p>
          <button className={`${btn} mt-3`} style={{ borderColor: "var(--paper-ink)" }} onClick={onConnect} disabled={!!busy}>{busy ?? "Connect wallet"}</button>
        </section>
      ) : (
        <section className="slip text-sm">
          <div className="dim break-all">Connected {acct} · {ausd(bal)} AUSD{handle ? ` · curator ${handle}` : ""}</div>
          {!handle && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="font-bold">1. Become a curator</div>
              <p className="dim">Posts a {ausd(minBond)} AUSD bond (a sybil-cost deposit, not slashed in v1) and picks a handle. Need AUSD? Request it from the Agora testnet faucet.</p>
              <label className={lab}>Handle<input className={field} style={{ borderColor: "var(--paper-ink)" }} value={newHandle} onChange={(e) => setNewHandle(e.target.value)} placeholder="your-name" /></label>
              <button className={btn} style={{ borderColor: "var(--paper-ink)" }} onClick={onRegister} disabled={!!busy}>{busy ?? `Register with ${ausd(minBond)} AUSD bond`}</button>
            </div>
          )}
          {handle && (
            <div className="mt-3 flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <div className="font-bold">Your price {rate === BigInt(0) ? "(not selling yet)" : `(${ausd(rate * BigInt(3600))} AUSD per hour)`}</div>
                <div className="flex gap-2 items-end">
                  <label className={lab}>AUSD per hour<input className={field} style={{ borderColor: "var(--paper-ink)" }} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></label>
                  <button className={btn} style={{ borderColor: "var(--paper-ink)" }} onClick={onRate} disabled={!!busy}>Set price</button>
                </div>
                <p className="dim">Applies to new subscribers only; running subscriptions keep their rate.</p>
              </div>
              <div className="flex flex-col gap-3">
                <div className="font-bold">Seal a call</div>
                <div className="grid grid-cols-2 gap-3">
                  <label className={lab}>Market<select className={field} style={{ borderColor: "var(--paper-ink)" }} value={perp} onChange={(e) => setPerp(e.target.value)}>{Object.entries(MARKETS).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
                  <label className={lab}>Direction<select className={field} style={{ borderColor: "var(--paper-ink)" }} value={dir} onChange={(e) => setDir(Number(e.target.value) as 1 | 2)}><option value={1}>LONG</option><option value={2}>SHORT</option></select></label>
                  <label className={lab}>Take profit %<input className={field} style={{ borderColor: "var(--paper-ink)" }} value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" /></label>
                  <label className={lab}>Stop loss % (required)<input className={field} style={{ borderColor: "var(--paper-ink)" }} value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" /></label>
                  <label className={lab}>Horizon (minutes)<input className={field} style={{ borderColor: "var(--paper-ink)" }} value={horizonMin} onChange={(e) => setHorizonMin(e.target.value)} inputMode="numeric" /></label>
                </div>
                <p className="dim">You must reveal before the horizon ends or the call scores −30%. One open call per market.</p>
                <button className={btn} style={{ borderColor: "var(--stamp-red)", color: "var(--stamp-red)" }} onClick={onSeal} disabled={!!busy}>{busy ?? "Seal on Monad"}</button>
              </div>
              {saved.filter((s) => s.callId > 0).length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="font-bold">Your sealed calls (secrets are kept in this browser and on the delivery server)</div>
                  {saved.filter((s) => s.callId > 0).map((s) => (
                    <div key={s.callId} className="flex items-center justify-between gap-2">
                      <Link className="underline" href={`/call/${s.callId}${dep === "staging" ? "?deployment=staging" : ""}`}>Call #{s.callId}</Link>
                      <span className="flex gap-2">
                        {!s.revealed && <button className={btn} style={{ borderColor: "var(--paper-ink)" }} onClick={() => onResend(s)} disabled={!!busy}>Re-send to subscribers</button>}
                        {s.revealed ? <span className="dim">revealed</span> : <button className={btn} style={{ borderColor: "var(--paper-ink)" }} onClick={() => onReveal(s)} disabled={!!busy}>Reveal</button>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {busy && <div className="mt-3 dim">{busy}… confirm in your wallet if asked.</div>}
          {error && <div role="alert" className="mt-3" style={{ color: "var(--stamp-red)" }}>{error}</div>}
          {txs.map((t) => <div key={t} className="mt-1 break-all text-xs dim"><a className="underline" href={`${EXPLORER}/tx/${t}`}>tx {t}</a></div>)}
        </section>
      )}
    </div>
  );
}
