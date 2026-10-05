import Link from "next/link";
import { notFound } from "next/navigation";
import { Receipt } from "@/components/Receipt";
import { getCallView } from "@/lib/calls";

export const dynamic = "force-dynamic";

export default async function CallPage({ params }: PageProps<"/call/[id]">) {
  const { id } = await params;
  const n = Number(id);
  const c = await getCallView(n);
  if (!c) notFound();
  return (
    <>
      <Link href="/" className="mt-4 inline-block text-sm underline">← all receipts</Link>
      <div className="mt-4"><Receipt c={c} link={false} /></div>
    </>
  );
}
