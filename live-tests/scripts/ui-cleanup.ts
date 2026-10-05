/** Reveals and settles the staging call left open by ui-setup.ts so the slot is free for the next run. */
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import { abis, deployment, publicClient, repoRoot, record, send, sleep, wallet, waitUntilTimestamp } from "../src/chain.js";

const CR = deployment.callRegistry, A = wallet("TESTER_CURATOR"), K = wallet("KEEPER");
const id = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, 32n] })) as bigint;
if (id === 0n) { console.log("nothing open"); process.exit(0); }
const dir = path.join(repoRoot, "docs", "live-runs");
const salt = fs.readdirSync(dir).sort().reverse().flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").reverse())
  .map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((r) => r.name === "ui.setup" && BigInt(r.id) === id)?.salt as Hex;
const call = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as { status: number; horizonEnd: bigint };
if (call.status === 1) await send(A, CR, abis.call, "reveal", [id, 2, 150, 75, salt]);
await waitUntilTimestamp(call.horizonEnd);
for (let i = 0; i < 60; i++) {
  try { const s = await send(K, deployment.settlerV1, abis.settler, "settle", [id]); if (s.receipt.status === "success") { record("ui.cleanup.settled", { id, tx: s.hash }); console.log("settled", id.toString()); process.exit(0); } } catch { /* oracle not fresh yet */ }
  await sleep(5000);
}
process.exit(1);
