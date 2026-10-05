"use client";
import { useState } from "react";
import { parseAbi, type Address } from "viem";
import { AUSD_FAUCET, EXPLORER, MON_FAUCET_URL } from "@/lib/config";
import { clients, humanError, monad } from "@/lib/wallet";

const abi = parseAbi(["function requestFunds(address to)"]);

/** Asks the Agora testnet faucet contract for 10,000 test AUSD, sent to the connected wallet. */
export function FaucetButton({ account, onDone }: { account: Address; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setMsg(null);
    try {
      const { pub, wallet } = clients(account);
      const hash = await wallet.writeContract({ address: AUSD_FAUCET, abi, functionName: "requestFunds", args: [account], account, chain: monad } as never);
      const r = await pub.waitForTransactionReceipt({ hash });
      setTx(hash);
      if (r.status !== "success") throw new Error("The faucet refused. It allows one request per minute and stops at 100,000 AUSD per wallet.");
      setMsg("10,000 test AUSD sent to your wallet.");
      onDone?.();
    } catch (e) { setMsg(humanError(e)); } finally { setBusy(false); }
  };
  return (
    <div className="text-sm">
      <button onClick={go} disabled={busy} className="border-2 px-3 py-2 font-bold disabled:opacity-50" style={{ borderColor: "var(--paper-ink)" }}>
        {busy ? "Requesting…" : "Get 10,000 test AUSD"}
      </button>
      <span className="dim ml-2">Need gas? <a className="underline" href={MON_FAUCET_URL} target="_blank" rel="noopener noreferrer">MON faucet</a></span>
      {msg && <div className="mt-1">{msg}</div>}
      {tx && <div className="break-all text-xs dim"><a className="underline" href={`${EXPLORER}/tx/${tx}`}>tx {tx}</a></div>}
    </div>
  );
}
