import { Redis } from "@upstash/redis";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { callRegistryAbi, subscriptionsAbi } from "./abi";
import { client } from "./calls";
import { CHAIN_ID, DEPLOYMENTS, type DeploymentName } from "./config";

/**
 * Delivery store. TRUST MODEL: this server sees the plaintext of a sealed call before it is revealed, so it is trusted
 * for availability and confidentiality only. It is NEVER trusted for integrity: every stored plaintext must hash to the
 * on-chain commit, and clients re-check the hash themselves.
 */
export const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! });

export type Plain = { perpId: number; direction: 1 | 2; tpBps: number; slBps: number; horizonSecs: number; salt: Hex };

export function deploymentOf(v: string | null): DeploymentName {
  return v === "staging" ? "staging" : "production";
}

/** keccak256(abi.encode(chainid, registry, curator, perpId, direction, tp, sl, horizonSecs, salt)), same as CallRegistry.hashCall */
export function hashPlain(registry: Address, curator: Address, p: Plain): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [BigInt(CHAIN_ID), registry, curator, BigInt(p.perpId), p.direction, p.tpBps, p.slBps, p.horizonSecs, p.salt],
    ),
  );
}

export async function readOnchainCall(dep: DeploymentName, id: number) {
  const registry = DEPLOYMENTS[dep].callRegistry as Address;
  const next = Number(await client.readContract({ address: registry, abi: callRegistryAbi, functionName: "nextCallId" }));
  if (!Number.isInteger(id) || id < 1 || id >= next) return null;
  return client.readContract({ address: registry, abi: callRegistryAbi, functionName: "getCall", args: [BigInt(id)] });
}

export async function isSubscribed(dep: DeploymentName, subscriber: Address, curator: Address): Promise<boolean> {
  return client.readContract({
    address: DEPLOYMENTS[dep].subscriptions as Address, abi: subscriptionsAbi, functionName: "isActive", args: [subscriber, curator],
  });
}

export const plainKey = (dep: DeploymentName, id: number) => `plain:${dep}:${id}`;

/** The text a subscriber signs to read a sealed call. Bound to call, deployment and time (5 minute window). */
export const accessMessage = (dep: DeploymentName, id: number, ts: number) => `Receipts: read call ${id} on ${dep} at ${ts}`;
