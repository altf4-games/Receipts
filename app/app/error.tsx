"use client";
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="slip mt-8 text-sm">
      <div className="font-bold">Could not load this page.</div>
      <p className="dim">The public Monad RPC or the indexer did not answer in time. Nothing was lost: every receipt lives on chain.</p>
      <button className="mt-3 border-2 px-3 py-2 font-bold" style={{ borderColor: "var(--paper-ink)" }} onClick={reset}>Try again</button>
    </div>
  );
}
