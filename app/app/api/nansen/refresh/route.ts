import { NextResponse } from "next/server";
import { envio } from "@/lib/envio";
import { SM_SYMBOLS, NansenBudgetError, refreshSymbol, refreshWallet } from "@/lib/nansen";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily refresh of the stored Nansen data (Vercel cron, or by hand with the secret). Pages never call Nansen themselves. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const force = new URL(req.url).searchParams.get("force") === "1";
  const out: Record<string, unknown>[] = [];
  try {
    for (const s of SM_SYMBOLS) out.push(await refreshSymbol(s, force));
    const d = await envio<{ Curator: { linkedWallets: string[] }[] }>(`{ Curator(where:{chainId:{_eq:10143}}) { linkedWallets } }`, 0);
    for (const w of new Set(d.Curator.flatMap((c) => c.linkedWallets))) {
      const i = await refreshWallet(w, force);
      out.push({ wallet: w, related: i.related.length, pnl: !!i.pnl });
    }
  } catch (e) {
    return NextResponse.json({ done: out, error: (e as Error).message, budget: e instanceof NansenBudgetError }, { status: e instanceof NansenBudgetError ? 200 : 500 });
  }
  return NextResponse.json({ done: out });
}
