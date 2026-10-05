"use client";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { STAGES, headsFailed, stagesOf, startHeads, type Stage } from "@/lib/heads";
import { clients } from "@/lib/wallet";

/**
 * Shows when the commit transaction's block was Proposed, Voted and Finalized according to Monad's monadNewHeads
 * stream, in milliseconds since the wallet returned the transaction hash. Measured in this browser, not claimed.
 */
export function SealTracker({ hash, t0 }: { hash: Hex; t0: number }) {
  const [block, setBlock] = useState<number | null>(null);
  const [times, setTimes] = useState<Partial<Record<Stage, number>>>({});

  useEffect(() => {
    startHeads();
    let n: number | null = null;
    const tick = setInterval(async () => {
      try {
        if (n === null) {
          const r = await clients().pub.getTransactionReceipt({ hash });
          n = Number(r.blockNumber);
          setBlock(n);
        }
        const abs = stagesOf(n);
        const rel: Partial<Record<Stage, number>> = {};
        for (const s of STAGES) if (abs[s] !== undefined) rel[s] = Math.max(0, abs[s]! - t0);
        setTimes(rel);
      } catch { /* not mined yet */ }
    }, 200);
    return () => clearInterval(tick);
  }, [hash, t0]);

  const done = times.Finalized !== undefined;
  return (
    <div className="mt-3 text-sm" aria-live="polite">
      <div className="font-bold">{done ? "Sealed." : "Sealing…"}{block ? ` Block ${block}` : ""}</div>
      <ol className="mt-1 flex flex-col gap-1">
        {STAGES.map((s) => (
          <li key={s} className="flex justify-between" style={{ opacity: times[s] !== undefined ? 1 : 0.4 }}>
            <span>{times[s] !== undefined ? "✓" : "…"} {s}</span>
            <span>{times[s] !== undefined ? `${times[s]} ms` : ""}</span>
          </li>
        ))}
      </ol>
      {done && <div className="stamp mt-2 stamp-drop" style={{ color: "var(--stamp-red)" }}>Sealed</div>}
      {headsFailed && <p className="dim mt-1">Live stage stream unavailable; the transaction itself is confirmed above.</p>}
    </div>
  );
}
