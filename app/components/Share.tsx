export function Share({ id, handle, market, site }: { id: number; handle: string; market: string; site: string }) {
  const text = `Receipt #${id}: ${handle} on ${market}, sealed on Monad. The call can't be deleted.`;
  const href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${site}/call/${id}`)}`;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block border-2 px-3 py-2 text-sm font-bold" style={{ borderColor: "var(--text)" }}>
      Share this receipt on X
    </a>
  );
}
