import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import callRegistryAbi from "./abi/CallRegistry.json" with { type: "json" };
import curatorRegistryAbi from "./abi/CuratorRegistry.json" with { type: "json" };
import settlerAbi from "./abi/SettlerV1.json" with { type: "json" };

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
config({ path: path.join(repoRoot, ".env") });

export const abis = {
  call: callRegistryAbi as Abi,
  curators: curatorRegistryAbi as Abi,
  settler: settlerAbi as Abi,
};

export const deployment = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "deployments", (process.env.DEPLOY_NAME ?? "staging") + ".json"), "utf8"),
) as {
  callRegistry: Address;
  curatorRegistry: Address;
  settlerV1: Address;
  exchange: Address;
  bondToken: Address;
  minBond: number;
  minHorizon: number;
  maxOracleAge: number;
  settlerDelay: number;
  deployer: Address;
};

export const AUSD = deployment.bondToken;
export const EXCHANGE = deployment.exchange;
export const FAUCET: Address = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz"] } },
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(undefined, { retryCount: 6, retryDelay: 400 }),
});

export function wallet(prefix: string) {
  const pk = process.env[`${prefix}_PRIVATE_KEY`] as Hex | undefined;
  if (!pk) throw new Error(`missing ${prefix}_PRIVATE_KEY in .env`);
  const account = privateKeyToAccount(pk);
  const client = createWalletClient({ account, chain: monadTestnet, transport: http() });
  return { account, client };
}
export type Wallet = ReturnType<typeof wallet>;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
export const faucetAbi = [
  { type: "function", name: "requestFunds", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [] },
] as const;

// ------------------------------------------------------------------ run log (evidence)
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(repoRoot, "docs", "live-runs");
export function record(name: string, data: Record<string, unknown>) {
  fs.mkdirSync(runDir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), name, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  fs.appendFileSync(path.join(runDir, `${runId}.jsonl`), line + "\n");
  console.log(`[live] ${name} ${line}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ sending
export type Sent = { hash: Hex; receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>; gasEstimate?: bigint; gasLimit: bigint };

/** Estimate (unless `gas` given), add margin (Monad charges the LIMIT, so keep it tight), send, wait. */
export async function send(
  w: Wallet,
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: unknown[],
  opts: { gas?: bigint; margin?: number } = {},
): Promise<Sent> {
  let gasEstimate: bigint | undefined;
  let gasLimit = opts.gas;
  if (gasLimit === undefined) {
    gasEstimate = await publicClient.estimateContractGas({ account: w.account, address, abi: abi as Abi, functionName, args } as never);
    gasLimit = BigInt(Math.ceil(Number(gasEstimate) * (opts.margin ?? 1.2)));
  }
  const hash = await w.client.writeContract({ address, abi: abi as Abi, functionName, args, gas: gasLimit } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, receipt, gasEstimate, gasLimit };
}

/** Name of the custom error a simulated call reverts with (or undefined if it did not revert / unknown). */
export async function simulateRevert(
  w: Wallet,
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
): Promise<string | undefined> {
  try {
    await publicClient.simulateContract({ account: w.account, address, abi, functionName, args } as never);
    return undefined;
  } catch (e) {
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "revert(no-name)";
    }
    return `unexpected: ${(e as Error).message.slice(0, 200)}`;
  }
}

// ------------------------------------------------------------------ chain reads
export async function chainNow(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}
export async function waitUntilTimestamp(ts: bigint, strictlyAfter = false) {
  for (;;) {
    const now = await chainNow();
    if (strictlyAfter ? now > ts : now >= ts) return now;
    await sleep(1000);
  }
}

/** Independent decode of getPerpetualInfo straight from the raw return bytes (struct head word i at hex offset (1+i)*64). */
export async function rawOracleAt(perpId: bigint, blockNumber?: bigint) {
  const data = ("0x00092cce" + perpId.toString(16).padStart(64, "0")) as Hex;
  const r = await publicClient.call({ to: EXCHANGE, data, blockNumber });
  const hex = (r.data as Hex).slice(2);
  const word = (i: number) => BigInt("0x" + hex.slice((1 + i) * 64, (2 + i) * 64));
  return { price: word(15), ts: word(16), decimals: Number(word(2)) };
}
