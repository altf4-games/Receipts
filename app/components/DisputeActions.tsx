"use client";
import { useState } from "react";
import type { Hex } from "viem";
import { settlerV2WriteAbi } from "@/lib/abi";
import { EXPLORER, TAPE } from "@/lib/config";
import { clients, connect, humanError, monad } from "@/lib/wallet";

/**
 * Anyone can challenge a proposal inside the dispute window by pointing at an EARLIER tape sample that already touched
 * take-profit or stop-loss; the contract re-checks it against the tape, so a wrong dispute simply reverts. After the window
 * anyone can finalize.
 */
export function DisputeActions({ callId, windowEnd, finalized, candidate }: { callId: number; windowEnd: number; finalized: boolean; candidate: number | null }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);
  const [now] = useState(() => Date.now() / 1000); // fixed at mount; the contract is the judge of whether the window is still open
  if (finalized) return null;
  const open = now < windowEnd;
  const run = async (fn: "dispute" | "finalize") => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const a = await connect();
      const { pub, wallet } = clients(a);
      const hash: Hex = await wallet.writeContract({
        address: TAPE.settlerV2, abi: settlerV2WriteAbi, functionName: fn, account: a, chain: monad,
        args: fn === "dispute" ? [BigInt(callId), candidate!] : [BigInt(callId)],
      } as never);
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("The transaction reverted.");
      setMsg(`Done: ${fn}. `); setTx(hash);
    } catch (e) {
      const m = humanError(e);
      setError(/NotEarlier|NotATouch|WindowClosed|WindowOpen|AlreadyFinalized|SampleOutsidePath|reverted/i.test(m) ? `The contract refused it: ${m}` : m);
    } finally { setBusy(false); }
  };
  const btn = "border-2 px-3 py-2 text-sm font-bold disabled:opacity-50";
  return (
    <div className="mt-3">
      {open && candidate !== null && <button className={btn} disabled={busy} onClick={() => run("dispute")}>{busy ? "Working…" : `Dispute with tape sample #${candidate}`}</button>}
      {open && candidate === null && <p className="text-xs dim">No earlier tape sample touched take-profit or stop-loss, so there is nothing to dispute with.</p>}
      {!open && <button className={btn} disabled={busy} onClick={() => run("finalize")}>{busy ? "Working…" : "Finalize (window closed)"}</button>}
      {msg && <p role="status" className="mt-2 text-xs">{msg}{tx && <a className="underline" href={`${EXPLORER}/tx/${tx}`}>transaction</a>}</p>}
      {error && <p role="alert" className="mt-2 text-xs" style={{ color: "var(--stamp-red)" }}>{error}</p>}
    </div>
  );
}
