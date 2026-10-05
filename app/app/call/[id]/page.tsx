import Link from "next/link";
import { notFound } from "next/navigation";
import { Receipt } from "@/components/Receipt";
import { Unlock } from "@/components/Unlock";
import { subscriptionsAbi } from "@/lib/abi";
import { client, getCallView } from "@/lib/calls";
import { DEPLOYMENTS } from "@/lib/config";
import { deploymentOf } from "@/lib/hash";

export const dynamic = "force-dynamic";

export default async function CallPage({ params, searchParams }: PageProps<"/call/[id]">) {
  const { id } = await params;
  const dep = deploymentOf(((await searchParams).deployment as string | undefined) ?? null);
  const n = Number(id);
  const c = await getCallView(n, dep);
  if (!c) notFound();
  const rate = c.status === "Sealed"
    ? await client.readContract({ address: DEPLOYMENTS[dep].subscriptions, abi: subscriptionsAbi, functionName: "ratePerSec", args: [c.curator] })
    : BigInt(0);
  return (
    <>
      <Link href="/" className="mt-4 inline-block text-sm underline">← all receipts</Link>
      <div className="mt-4"><Receipt c={c} link={false} /></div>
      <Unlock dep={dep} callId={c.id} curator={c.curator} handle={c.handle} status={c.status} ratePerSec={rate.toString()} />
    </>
  );
}
