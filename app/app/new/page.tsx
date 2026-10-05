import Link from "next/link";
import { NewCall } from "@/components/NewCall";
import { deploymentOf } from "@/lib/hash";

export default async function NewPage({ searchParams }: PageProps<"/new">) {
  const dep = deploymentOf(((await searchParams).deployment as string | undefined) ?? null);
  return (
    <>
      <Link href="/" className="mt-4 inline-block text-sm underline">← all receipts</Link>
      <h1 className="mt-4 text-sm font-bold uppercase tracking-widest">Publish a call</h1>
      <NewCall dep={dep} />
    </>
  );
}
