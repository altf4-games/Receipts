import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Signer } from "./tick.js";

export const monadTestnet = (rpc: string) =>
  defineChain({
    id: 10143,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });

/** `batch: true` folds concurrent reads into one JSON-RPC request (fewer subrequests; matters on Cloudflare Free: 50 max). */
export function makePublicClient(rpc: string) {
  return createPublicClient({ chain: monadTestnet(rpc), transport: http(rpc, { batch: true, retryCount: 5, retryDelay: 400 }) });
}

export function makeSigner(rpc: string, privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return { account, client: createWalletClient({ account, chain: monadTestnet(rpc), transport: http(rpc, { retryCount: 4, retryDelay: 400 }) }) };
}
