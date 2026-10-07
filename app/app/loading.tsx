export default function Loading() {
  return (
    <div className="slip mt-8 text-sm" role="status" aria-live="polite">
      <h1 className="font-bold">Reading the chain…</h1>
      <div className="dim">Receipts are read live from Monad; this takes a moment.</div>
    </div>
  );
}
