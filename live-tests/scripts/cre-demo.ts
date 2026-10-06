/**
 * Sets up the scene for the CRE demo video on the STAGING-V2 deployment (60 s dispute window), so the Chainlink CRE
 * workflow has real work to do when you run it:   DEPLOY_NAME=staging-v2 tsx scripts/cre-demo.ts setup
 *   1. TESTER_CURATOR commits and reveals a BTC call (150 s horizon, 1 bp take-profit / stop-loss: a touch is likely)
 *   2. the keeper wallet records path samples on the PriceTape until the horizon has passed
 *   3. it prints the exact CRE command to run next, and then leaves the proposal to the workflow
 * After the workflow has run:                      DEPLOY_NAME=staging-v2 tsx scripts/cre-demo.ts show <callId>
 *   prints the call, the proposal (who proposed what), and the tape samples used. Real transactions only.
 */
import path from "node:path";
import os from "node:os";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { abis, deployment, publicClient, send, sleep, wallet } from "../src/chain.js";

const CR = deployment.callRegistry, TAPE = deployment.priceTape as Address, V2 = deployment.settlerV2 as Address;
const BTC = 16n;
const A = wallet("TESTER_CURATOR"), KEEPER = wallet("KEEPER");
const mode = process.argv[2];

const hash = (curator: Address, dir: number, tp: number, sl: number, horizon: number, salt: Hex): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" }],
    [10143n, CR, curator, BTC, dir, tp, sl, horizon, salt]));

if (deployment.name !== "staging-v2") throw new Error("run with DEPLOY_NAME=staging-v2");

if (mode === "setup") {
  const open = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, BTC] })) as bigint;
  if (open !== 0n) throw new Error(`TESTER_CURATOR already has open BTC call #${open} on staging-v2: finish or expire it first`);
  const dir = 1, tp = 1, sl = 1, horizon = 150;
  const salt = keccak256(toHex(crypto.randomUUID())) as Hex;
  const commit = await send(A, CR, abis.call, "commit", [BTC, hash(A.account.address, dir, tp, sl, horizon, salt), horizon]);
  const id = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, BTC] })) as bigint;
  const reveal = await send(A, CR, abis.call, "reveal", [id, dir, tp, sl, salt]);
  const c = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as { horizonEnd: bigint; entryPNS: bigint };
  console.log(`call #${id}: commit ${commit.hash}\n  reveal ${reveal.hash}\n  entry ${c.entryPNS}, horizon ends at ${new Date(Number(c.horizonEnd) * 1000).toLocaleTimeString()}`);
  while ((await publicClient.getBlock()).timestamp < c.horizonEnd + 5n) {
    const s = await send(KEEPER, TAPE, abis.tape, "sample", [[BTC]]);
    console.log(`  path sample tx ${s.hash}`);
    await sleep(20_000);
  }
  console.log(`\nReady. Now run the CRE workflow (this is what to record):\n  cd cre && ${path.join(os.homedir(), ".cre", "bin", "cre")} workflow simulate tape-and-settle --target staging-settings --broadcast --non-interactive --trigger-index 0\nThen:\n  DEPLOY_NAME=staging-v2 tsx scripts/cre-demo.ts show ${id}`);
} else if (mode === "show") {
  const id = BigInt(process.argv[3] ?? "0");
  const c = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as { status: number; scoreBps: number; flags: number; entryPNS: bigint; horizonEnd: bigint };
  const p = (await publicClient.readContract({ address: V2, abi: abis.settlerV2, functionName: "proposals", args: [id] })) as readonly [bigint, number, number, boolean, boolean, boolean];
  console.log(`call #${id}: status ${c.status}, score ${c.scoreBps}, flags ${c.flags}, entry ${c.entryPNS}`);
  console.log(`proposal: proposedAt ${p[0]}, tape index ${p[1]}, score ${p[2]} bps, touch ${p[3]}, disputed ${p[4]}, finalized ${p[5]}`);
  const n = (await publicClient.readContract({ address: TAPE, abi: abis.tape, functionName: "sampleCount", args: [BTC] })) as bigint;
  console.log(`tape has ${n} BTC samples; finalize after the 60 s window with: cast send ${V2} 'finalize(uint256)' ${id}`);
} else {
  console.log("usage: DEPLOY_NAME=staging-v2 tsx scripts/cre-demo.ts setup | show <callId>");
}
