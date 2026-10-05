export default function Loading() {
  return (
    <div className="slip mt-8 text-sm" role="status" aria-live="polite">
      <div className="font-bold">Reading the chain…</div>
      <div className="dim">Receipts are read live from Monad; this takes a moment.</div>
    </div>
  );
}
