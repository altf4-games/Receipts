import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Signer } from "./tick.js";

export const monadTestnet = (rpc: string) =>
  defineChain({
    id: 10143,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    // standard Multicall3 (code present on Monad testnet): lets a tick read every pair in ONE eth_call
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });

/** `batch: true` folds concurrent reads into one JSON-RPC request (fewer subrequests; matters on Cloudflare Free: 50 max). */
export function makePublicClient(rpc: string) {
  return createPublicClient({ chain: monadTestnet(rpc), transport: http(rpc, { batch: true, retryCount: 5, retryDelay: 400 }) });
}

export function makeSigner(rpc: string, privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return { account, client: createWalletClient({ account, chain: monadTestnet(rpc), transport: http(rpc, { retryCount: 4, retryDelay: 400 }) }) };
}
