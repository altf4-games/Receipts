import { Receipt } from "@/components/Receipt";
import { recentCalls } from "@/lib/calls";

export const dynamic = "force-dynamic";

export default async function Home() {
  let data: Awaited<ReturnType<typeof recentCalls>> | null = null;
  let error: string | null = null;
  try {
    data = await recentCalls(12);
  } catch (e) {
    error = (e as Error).message.split("\n")[0];
  }
  return (
    <>
      <p className="mt-4 text-sm" style={{ color: "var(--text-dim)" }}>
        Finfluencers delete their bad calls. On Receipts, they can&apos;t. Every call is sealed on Monad with Perpl&apos;s
        oracle price snapshotted in the same transaction; a call that is never revealed scores −30%.
      </p>
      <h1 className="mt-6 mb-3 text-sm font-bold uppercase tracking-widest">
        Latest receipts{data ? ` · ${data.total} sealed so far` : ""}
      </h1>
      {error && (
        <div role="alert" className="slip text-sm">Could not read the chain right now ({error}). Reload in a few seconds.</div>
      )}
      {data && data.calls.length === 0 && <div className="slip text-sm">No calls yet.</div>}
      <div className="flex flex-col gap-6">
        {data?.calls.map((c) => <Receipt key={c.id} c={c} />)}
      </div>
    </>
  );
}
