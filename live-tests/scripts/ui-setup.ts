/** Creates one real SEALED call on STAGING for the browser test: curator sells at a rate, commits ETH, uploads plaintext to the deployed app. Prints the call id. */
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { abis, deployment, publicClient, record, send, wallet } from "../src/chain.js";

const APP = process.env.APP_URL ?? "https://receipts-app-rho-ashy.vercel.app";
const CR = deployment.callRegistry, SUBS = deployment.subscriptions as Address;
const A = wallet("TESTER_CURATOR");
const ETH = 32n;
const open = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, ETH] })) as bigint;
if (open !== 0n) { console.log("ALREADY_OPEN", open.toString()); process.exit(0); }
await send(A, SUBS, abis.subscriptions, "setRate", [10_000n]);
const salt = keccak256(toHex(crypto.randomUUID())) as Hex;
const plain = { perpId: 32, direction: 2, tpBps: 150, slBps: 75, horizonSecs: 900, salt };
const hash = keccak256(encodeAbiParameters(
  [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" }],
  [10143n, CR, A.account.address, ETH, plain.direction, plain.tpBps, plain.slBps, plain.horizonSecs, salt]));
const c = await send(A, CR, abis.call, "commit", [ETH, hash, plain.horizonSecs]);
const id = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, ETH] })) as bigint;
const r = await fetch(`${APP}/api/calls?deployment=staging`, { method: "POST", body: JSON.stringify({ callId: Number(id), ...plain }) });
record("ui.setup", { id, commit: c.hash, upload: r.status, salt });
console.log("CALL_ID", id.toString(), "upload", r.status);
