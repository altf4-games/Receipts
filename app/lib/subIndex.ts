import { parseAbiItem, type Address } from "viem";
import { client, curatorInfo } from "./calls";
import { DEPLOYMENTS, SUBS_DEPLOY_BLOCK, type DeploymentName } from "./config";
import { redis } from "./delivery";

/**
 * Stand-in for the Envio indexer (Phase 5): scans Subscriptions' `Subscribed` events and remembers who subscribed to
 * whom in Redis. The public RPC limits eth_getLogs to a 100-block range, so the scan is incremental: a cursor in Redis
 * advances a bounded number of chunks per request. Sets are idempotent, so overlapping scans are harmless.
 */
const subscribed = parseAbiItem(
  "event Subscribed(address indexed subscriber, address indexed curator, address indexed payer, uint256 amount, uint128 rate, uint64 start, uint64 activeUntil)",
);
const CHUNK = BigInt(90);
const MAX_CHUNKS = 120;
const PARALLEL = 5;

export async function advanceIndex(dep: DeploymentName): Promise<{ cursor: number; head: number }> {
  const cursorKey = `idx:${dep}:cursor`;
  const lockKey = `idx:${dep}:lock`;
  const head = Number(await client.getBlockNumber());
  let cursor = (await redis.get<number>(cursorKey)) ?? SUBS_DEPLOY_BLOCK[dep];
  if (cursor > head) return { cursor, head };
  const locked = await redis.set(lockKey, "1", { nx: true, ex: 20 });
  if (!locked) return { cursor, head };
  try {
    const ranges: [bigint, bigint][] = [];
    for (let from = BigInt(cursor), i = 0; from <= BigInt(head) && i < MAX_CHUNKS; from += CHUNK + BigInt(1), i++) {
      const to = from + CHUNK > BigInt(head) ? BigInt(head) : from + CHUNK;
      ranges.push([from, to]);
    }
    for (let i = 0; i < ranges.length; i += PARALLEL) {
      const batch = ranges.slice(i, i + PARALLEL);
      const results = await Promise.all(
        batch.map(([fromBlock, toBlock]) => client.getLogs({ address: DEPLOYMENTS[dep].subscriptions, event: subscribed, fromBlock, toBlock })),
      );
      for (const logs of results) {
        for (const l of logs) {
          const sub = l.args.subscriber!.toLowerCase(), cur = l.args.curator!.toLowerCase();
          await Promise.all([redis.sadd(`idx:${dep}:cur:${cur}`, sub), redis.sadd(`idx:${dep}:sub:${sub}`, cur)]);
        }
      }
      cursor = Number(batch[batch.length - 1][1]) + 1;
      await redis.set(cursorKey, cursor);
      if (i + PARALLEL < ranges.length) await new Promise((r) => setTimeout(r, 450));
    }
  } finally {
    await redis.del(lockKey);
  }
  return { cursor, head };
}

const subsAbi = [
  { type: "function", name: "getStream", stateMutability: "view", inputs: [{ name: "curator", type: "address" }, { name: "subscriber", type: "address" }], outputs: [{ type: "tuple", components: [{ name: "deposit", type: "uint128" }, { name: "claimed", type: "uint128" }, { name: "rate", type: "uint128" }, { name: "start", type: "uint64" }] }] },
  { type: "function", name: "accrued", stateMutability: "view", inputs: [{ name: "subscriber", type: "address" }, { name: "curator", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isActive", stateMutability: "view", inputs: [{ name: "subscriber", type: "address" }, { name: "curator", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "activeUntil", stateMutability: "view", inputs: [{ name: "subscriber", type: "address" }, { name: "curator", type: "address" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "owed", stateMutability: "view", inputs: [{ name: "curator", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function pair(dep: DeploymentName, subscriber: Address, curator: Address) {
  const address = DEPLOYMENTS[dep].subscriptions;
  const [s, accrued, active, until] = await Promise.all([
    client.readContract({ address, abi: subsAbi, functionName: "getStream", args: [curator, subscriber] }),
    client.readContract({ address, abi: subsAbi, functionName: "accrued", args: [subscriber, curator] }),
    client.readContract({ address, abi: subsAbi, functionName: "isActive", args: [subscriber, curator] }),
    client.readContract({ address, abi: subsAbi, functionName: "activeUntil", args: [subscriber, curator] }),
  ]);
  return {
    deposit: s.deposit.toString(), claimed: s.claimed.toString(), accrued: accrued.toString(),
    refundable: (s.deposit - accrued).toString(), unclaimed: (accrued - s.claimed).toString(), active, activeUntil: Number(until),
  };
}

export async function accountView(dep: DeploymentName, account: Address) {
  const idx = await advanceIndex(dep);
  const a = account.toLowerCase();
  const [subscribers, curators] = await Promise.all([
    redis.smembers(`idx:${dep}:cur:${a}`) as Promise<Address[]>,
    redis.smembers(`idx:${dep}:sub:${a}`) as Promise<Address[]>,
  ]);
  const owed = await client.readContract({ address: DEPLOYMENTS[dep].subscriptions, abi: subsAbi, functionName: "owed", args: [account] });
  const asCurator = (await Promise.all(subscribers.map(async (s) => ({ subscriber: s, ...(await pair(dep, s, account)) })))).filter((x) => x.deposit !== "0");
  const asSubscriber = (await Promise.all(curators.map(async (c) => ({ curator: c, handle: (await curatorInfo(dep, c)).handle, ...(await pair(dep, account, c)) })))).filter((x) => x.deposit !== "0");
  return { ...idx, owed: owed.toString(), asCurator, asSubscriber };
}
