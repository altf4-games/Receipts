"use client";
import { useState } from "react";
import { parseAbi, type Address } from "viem";
import { AUSD_FAUCET, EXPLORER, MON_FAUCET_URL } from "@/lib/config";
import { clients, humanError, monad } from "@/lib/wallet";

const abi = parseAbi(["function requestFunds(address to)"]);

/**
 * First-use funding. "Get free test money" asks the app's own funding wallet (testnet only) for a little MON for gas and
 * 200 test dollars (AUSD). "More dollars" asks the Agora faucet contract for 10,000 AUSD directly from the user's wallet.
 */
export function FaucetButton({ account, onDone }: { account: Address; onDone?: () => void }) {
  const [busy, setBusy] = useState<"starter" | "agora" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [txs, setTxs] = useState<string[]>([]);

  const starter = async () => {
    setBusy("starter"); setMsg(null); setTxs([]);
    try {
      const r = await fetch("/api/starter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      if (b.status === "already-funded") setMsg("You already have enough for gas and for a subscription.");
      else {
        setMsg(`Sent ${b.mon !== "0" ? "0.25 MON for gas" : ""}${b.mon !== "0" && b.ausd !== "0" ? " and " : ""}${b.ausd !== "0" ? "200 test dollars (AUSD)" : ""} to your wallet.`);
        setTxs(Object.values(b.tx ?? {}) as string[]);
      }
      onDone?.();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  };

  const agora = async () => {
    setBusy("agora"); setMsg(null); setTxs([]);
    try {
      const { pub, wallet } = clients(account);
      const hash = await wallet.writeContract({ address: AUSD_FAUCET, abi, functionName: "requestFunds", args: [account], account, chain: monad } as never);
      const r = await pub.waitForTransactionReceipt({ hash });
      setTxs([hash]);
      if (r.status !== "success") throw new Error("The faucet refused. It allows one request per minute and stops at 100,000 AUSD per wallet.");
      setMsg("10,000 test dollars (AUSD) sent to your wallet.");
      onDone?.();
    } catch (e) { setMsg(humanError(e)); } finally { setBusy(null); }
  };

  const btn = "border-2 px-3 py-2 font-bold disabled:opacity-50";
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={starter} disabled={busy !== null} className={btn} style={{ borderColor: "var(--paper-ink)" }}>{busy === "starter" ? "Sending…" : "Get free test money"}</button>
        <button onClick={agora} disabled={busy !== null} className="border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: "var(--paper-dim)" }}>{busy === "agora" ? "Requesting…" : "More dollars (10,000)"}</button>
      </div>
      <div className="dim mt-1 text-xs">Test money only, nothing here costs real money. Still short of gas? <a className="underline" href={MON_FAUCET_URL} target="_blank" rel="noopener noreferrer">MON faucet</a></div>
      {msg && <div role="status" className="mt-1">{msg}</div>}
      {txs.map((t) => <div key={t} className="break-all text-xs dim"><a className="underline" href={`${EXPLORER}/tx/${t}`}>tx {t}</a></div>)}
    </div>
  );
}
