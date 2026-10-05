import { Redis } from "@upstash/redis";
import type { Address } from "viem";
import { callRegistryAbi, subscriptionsAbi } from "./abi";
import { client } from "./calls";
import { DEPLOYMENTS, type DeploymentName } from "./config";

/**
 * Delivery store. TRUST MODEL: this server sees the plaintext of a sealed call before it is revealed, so it is trusted
 * for availability and confidentiality only. It is NEVER trusted for integrity: every stored plaintext must hash to the
 * on-chain commit, and clients re-check the hash themselves.
 */
export const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! });

export { hashPlain, deploymentOf, type Plain } from "./hash";
import type { Plain } from "./hash";

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
