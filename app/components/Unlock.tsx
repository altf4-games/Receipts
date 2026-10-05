"use client";
import { useCallback, useState } from "react";
import type { Address, Hex } from "viem";
import { callRegistryAbi, erc20Abi, subscriptionsAbi } from "@/lib/abi";
import { DEPLOYMENTS, EXPLORER, type DeploymentName } from "@/lib/config";
import { hashPlain, type Plain } from "@/lib/hash";
import { FaucetButton } from "@/components/FaucetButton";
import { clients, connect, humanError, monad, provider } from "@/lib/wallet";

type Props = { dep: DeploymentName; callId: number; curator: Address; handle: string; status: string; ratePerSec: string };
type Unlocked = { plain: Plain; onchainHash: Hex; ok: boolean; block: string };

const DURATIONS = [
  { label: "10 min", secs: 600 },
  { label: "1 hour", secs: 3600 },
  { label: "1 day", secs: 86400 },
];
const ausd = (n: bigint) => (Number(n) / 1e6).toFixed(n % BigInt(10000) === BigInt(0) ? 2 : 6);

export function Unlock({ dep, callId, curator, handle, status, ratePerSec }: Props) {
  const addrs = DEPLOYMENTS[dep];
  const rate = BigInt(ratePerSec);
  const [account, setAccount] = useState<Address | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txs, setTxs] = useState<Hex[]>([]);
  const [result, setResult] = useState<Unlocked | null>(null);

  const refresh = useCallback(async (who: Address) => {
    const { pub } = clients();
    const [a, u] = await Promise.all([
      pub.readContract({ address: addrs.subscriptions, abi: subscriptionsAbi, functionName: "isActive", args: [who, curator] }),
      pub.readContract({ address: addrs.subscriptions, abi: subscriptionsAbi, functionName: "activeUntil", args: [who, curator] }),
    ]);
    setActive(a);
    setUntil(Number(u));
  }, [addrs.subscriptions, curator]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError(humanError(e)); } finally { setBusy(null); }
  };

  const onConnect = () => run("Connecting", async () => {
    const a = await connect();
    setAccount(a);
    await refresh(a);
  });

  const onSubscribe = (secs: number) => run("Subscribing", async () => {
    const { pub, wallet } = clients(account!);
    const amount = rate * BigInt(secs);
    const bal = await pub.readContract({ address: addrs.ausd, abi: erc20Abi, functionName: "balanceOf", args: [account!] });
    if (bal < amount) throw new Error("transfer amount exceeds balance");
    const allowance = await pub.readContract({ address: addrs.ausd, abi: erc20Abi, functionName: "allowance", args: [account!, addrs.subscriptions] });
    if (allowance < amount) {
      setBusy("Approving AUSD (1 of 2)");
      const h = await wallet.writeContract({ address: addrs.ausd, abi: erc20Abi, functionName: "approve", args: [addrs.subscriptions, amount], account: account!, chain: monad } as never);
      await pub.waitForTransactionReceipt({ hash: h });
      setTxs((t) => [...t, h]);
    }
    setBusy("Subscribing (2 of 2)");
    const h = await wallet.writeContract({ address: addrs.subscriptions, abi: subscriptionsAbi, functionName: "subscribe", args: [curator, amount], account: account!, chain: monad } as never);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error("The subscription transaction reverted.");
    setTxs((t) => [...t, h]);
    await refresh(account!);
  });

  const onUnlock = () => run("Unlocking", async () => {
    const { pub, wallet } = clients(account!);
    const ts = Math.floor(Date.now() / 1000);
    const signature = await wallet.signMessage({ account: account!, message: `Receipts: read call ${callId} on ${dep} at ${ts}` });
    const res = await fetch(`/api/calls/${callId}?deployment=${dep}`, {
      headers: { "x-receipts-address": account!, "x-receipts-timestamp": String(ts), "x-receipts-signature": signature },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    // Verify in the browser against the chain, never trusting the server's own hash field.
    const call = await pub.readContract({ address: addrs.callRegistry, abi: callRegistryAbi, functionName: "getCall", args: [BigInt(callId)] });
    const plain: Plain = body.plaintext;
    const recomputed = hashPlain(addrs.callRegistry, call.curator, plain);
    setResult({ plain, onchainHash: call.hash, ok: recomputed === call.hash, block: call.commitBlock.toString() });
  });

  if (status !== "Sealed") return null;
  const noProvider = typeof window !== "undefined" && !provider();

  return (
    <section className="mt-6 slip text-sm" aria-live="polite">
      <div className="font-bold">Unlock this sealed call</div>
      <p className="dim mt-1">
        {handle} sold this call as a hash. Subscribe by the second and the plaintext is delivered to you; your browser checks it against the
        hash sealed on Monad.
      </p>
      <hr />
      {rate === BigInt(0) ? (
        <p>This curator has not opened subscriptions yet, so there is nothing to buy. The call will become public when it is revealed.</p>
      ) : (
        <>
          <div className="dim">Price: {ausd(rate * BigInt(3600))} AUSD per hour ({ratePerSec} units/s)</div>
          {!account ? (
            <button onClick={onConnect} disabled={!!busy} className="mt-3 border-2 px-3 py-2 font-bold" style={{ borderColor: "var(--paper-ink)" }}>
              {busy ?? "Connect wallet"}
            </button>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <div className="dim break-all">Connected {account} · {active ? `subscribed until ${new Date((until ?? 0) * 1000).toLocaleString()}` : "not subscribed"}</div>
              {!active && (
                <div className="flex flex-wrap gap-2">
                  {DURATIONS.map((d) => (
                    <button key={d.secs} onClick={() => onSubscribe(d.secs)} disabled={!!busy} className="border-2 px-3 py-2 font-bold" style={{ borderColor: "var(--paper-ink)" }}>
                      {d.label} · {ausd(rate * BigInt(d.secs))} AUSD
                    </button>
                  ))}
                </div>
              )}
              {active && !result && (
                <button onClick={onUnlock} disabled={!!busy} className="border-2 px-3 py-2 font-bold" style={{ borderColor: "var(--stamp-green)", color: "var(--stamp-green)" }}>
                  {busy ?? "Sign and unlock"}
                </button>
              )}
              {!active && <FaucetButton account={account} />}
              {busy && <div className="dim">{busy}… confirm in your wallet if asked.</div>}
            </div>
          )}
        </>
      )}
      {noProvider && !account && <p className="mt-2 dim">No browser wallet detected on this device.</p>}
      {error && <div role="alert" className="mt-3" style={{ color: "var(--stamp-red)" }}>{error}</div>}
      {txs.map((t) => (
        <div key={t} className="mt-2 break-all text-xs dim"><a className="underline" href={`${EXPLORER}/tx/${t}`}>tx {t}</a></div>
      ))}
      {result && (
        <div className="mt-4">
          <div className="font-bold" style={{ color: result.ok ? "var(--stamp-green)" : "var(--stamp-red)" }}>
            {result.ok ? `✓ matches sealed commit at block ${result.block}` : "✗ DOES NOT MATCH the sealed commit. Do not trust this call."}
          </div>
          {result.ok && <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="dim">Direction</dt><dd className="text-right">{result.plain.direction === 1 ? "LONG" : "SHORT"}</dd>
            <dt className="dim">Take profit</dt><dd className="text-right">+{(result.plain.tpBps / 100).toFixed(2)}%</dd>
            <dt className="dim">Stop loss</dt><dd className="text-right">−{(result.plain.slBps / 100).toFixed(2)}%</dd>
            <dt className="dim">Horizon</dt><dd className="text-right">{Math.round(result.plain.horizonSecs / 60)} min</dd>
          </dl>}
          <div className="mt-2 break-all text-[10px] dim">on-chain hash {result.onchainHash}</div>
        </div>
      )}
    </section>
  );
}
