import Link from "next/link";
import { notFound } from "next/navigation";
import { Receipt } from "@/components/Receipt";
import { Settlement } from "@/components/Settlement";
import { SmartMoney } from "@/components/SmartMoney";
import { Share } from "@/components/Share";
import { Unlock } from "@/components/Unlock";
import { subscriptionsAbi } from "@/lib/abi";
import { client, getCallView } from "@/lib/calls";
import { DEPLOYMENTS } from "@/lib/config";
import { deploymentOf } from "@/lib/hash";
import { smartMoneyFor } from "@/lib/smartMoneyView";
import { getTape } from "@/lib/tape";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params, searchParams }: PageProps<"/call/[id]">) {
  const { id } = await params;
  const dep = deploymentOf(((await searchParams).deployment as string | undefined) ?? null);
  const img = `/api/og/call/${id}${dep === "staging" ? "?deployment=staging" : ""}`;
  return {
    title: `Receipt #${id}`,
    openGraph: { title: `Receipt #${id}`, description: "A market call sealed on Monad with the oracle price in the same transaction.", images: [img] },
    twitter: { card: "summary_large_image" as const, images: [img] },
  };
}

export default async function CallPage({ params, searchParams }: PageProps<"/call/[id]">) {
  const { id } = await params;
  const dep = deploymentOf(((await searchParams).deployment as string | undefined) ?? null);
  const n = Number(id);
  const c = await getCallView(n, dep);
  if (!c) notFound();
  const rate = c.status === "Sealed"
    ? await client.readContract({ address: DEPLOYMENTS[dep].subscriptions, abi: subscriptionsAbi, functionName: "ratePerSec", args: [c.curator] })
    : BigInt(0);
  // the price tape exists only for the production deployment; a failed read must not break the receipt
  const tape = dep === "production" && c.status !== "Sealed"
    ? await getTape(c, c.entryPrice.split(".")[1]?.length ?? 0).catch(() => null)
    : null;
  const smc = c.direction ? (await smartMoneyFor([{ perpId: c.perpId, commitTime: c.commitTime, direction: c.direction === "LONG" ? 1 : 2 }]).catch(() => null))?.ctx[0] ?? null : null;
  return (
    <>
      <Link href="/" className="mt-4 inline-block text-sm underline">← all receipts</Link>
      <div className="mt-4"><Receipt c={c} link={false} /></div>
      <Settlement c={c} tape={tape} />
      <SmartMoney sm={smc} symbol={c.market} direction={c.direction} />
      <Share id={c.id} handle={c.handle} market={c.market} site={process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"} />
      <Unlock dep={dep} callId={c.id} curator={c.curator} handle={c.handle} status={c.status} ratePerSec={rate.toString()} />
    </>
  );
}
