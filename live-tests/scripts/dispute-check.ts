/**
 * Checks the UI's dispute / finalize path against a LIVE proposal on production: the same ABI the app uses
 * (app/lib/abi.ts settlerV2WriteAbi, custom errors included) must decode the contract's refusal.
 * Usage: tsx scripts/dispute-check.ts <callId>     (the call must have a proposal inside its 15-minute window)
 */
import { createPublicClient, http, BaseError, ContractFunctionRevertedError } from "viem";
import { settlerV2WriteAbi } from "../../app/lib/abi";
import { monadTestnet } from "../src/chain.js";
import production from "../../deployments/production.json" with { type: "json" };

const id = BigInt(process.argv[2] ?? "0");
const pc = createPublicClient({ chain: monadTestnet, transport: http() });
const V2 = production.settlerV2 as `0x${string}`;
const KEEPER = "0xEf77a024c296C6539436f699Aa16140047580D8e" as const;
const p = (await pc.readContract({ address: V2, abi: [{ type: "function", name: "proposals", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint64" }, { type: "uint32" }, { type: "int32" }, { type: "bool" }, { type: "bool" }, { type: "bool" }] }], functionName: "proposals", args: [id] })) as readonly [bigint, number, number, boolean, boolean, boolean];
console.log(`proposal for #${id}: proposedAt ${p[0]}, index ${p[1]}, score ${p[2]}, touch ${p[3]}, disputed ${p[4]}, finalized ${p[5]}`);
for (const [fn, args] of [["dispute", [id, 0]], ["finalize", [id]]] as const) {
  try {
    await pc.simulateContract({ address: V2, abi: settlerV2WriteAbi, functionName: fn, args, account: KEEPER } as never);
    console.log(`${fn}: simulation would SUCCEED`);
  } catch (e) {
    const err = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    console.log(`${fn}: refused as ${err instanceof ContractFunctionRevertedError ? err.data?.errorName : String(e).slice(0, 120)}`);
  }
}
