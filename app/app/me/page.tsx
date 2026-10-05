import { LinkIdentity } from "@/components/LinkIdentity";
import { Me } from "@/components/Me";
import { deploymentOf } from "@/lib/hash";

export default async function MePage({ searchParams }: PageProps<"/me">) {
  const dep = deploymentOf(((await searchParams).deployment as string | undefined) ?? null);
  return (
    <>
      <h1 className="mt-6 text-sm font-bold uppercase tracking-widest">Me</h1>
      <Me dep={dep} />
      <LinkIdentity dep={dep} />
    </>
  );
}
