/** Frees staging slots left by browser tests: settles Revealed calls and expires unrevealed ones, once their horizons pass. */
import type { Address } from "viem";
import { abis, deployment, publicClient, record, send, sleep, wallet, chainNow } from "../src/chain.js";

const CR = deployment.callRegistry, K = wallet("KEEPER");
const next = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "nextCallId" })) as bigint;
type C = { status: number; horizonEnd: bigint; curator: Address };
const todo: { id: bigint; status: number; horizonEnd: bigint }[] = [];
for (let id = next - 1n; id > next - 25n && id > 0n; id--) {
  const c = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as C;
  if (c.status === 1 || c.status === 2) todo.push({ id, status: c.status, horizonEnd: c.horizonEnd });
}
console.log("open:", todo.map((t) => `${t.id}:${t.status}`).join(" ") || "none");
for (const t of todo) {
  for (let i = 0; i < 400; i++) {
    const now = await chainNow();
    if (now > t.horizonEnd) break;
    await sleep(5000);
  }
  for (let i = 0; i < 40; i++) {
    try {
      const s = t.status === 2
        ? await send(K, deployment.settlerV1, abis.settler, "settle", [t.id])
        : await send(K, CR, abis.call, "expire", [t.id]);
      if (s.receipt.status === "success") { record("sweep", { id: t.id, kind: t.status === 2 ? "settle" : "expire", tx: s.hash }); console.log("done", t.id.toString()); break; }
    } catch { await sleep(5000); }
  }
}
process.exit(0);
