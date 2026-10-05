"use client";
import { createPublicClient, createWalletClient, custom, defineChain, type Address, type EIP1193Provider } from "viem";
import { CHAIN_ID, RPC_URL } from "./config";

export const monad = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
});

export function provider(): EIP1193Provider | null {
  return typeof window === "undefined" ? null : ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null);
}

export async function connect(): Promise<Address> {
  const p = provider();
  if (!p) throw new Error("No browser wallet found. Install MetaMask or another EIP-1193 wallet.");
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as Address[];
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902 && (e as { code?: number }).code !== -32603) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: `0x${CHAIN_ID.toString(16)}`, chainName: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: [RPC_URL], blockExplorerUrls: ["https://testnet.monadvision.com"],
      }],
    });
  }
  return accounts[0];
}

export function clients(account?: Address) {
  const p = provider()!;
  return {
    pub: createPublicClient({ chain: monad, transport: custom(p) }),
    wallet: createWalletClient({ chain: monad, transport: custom(p), account }),
  };
}

/** Wallet and RPC errors in words a user can act on. */
export function humanError(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string };
  if (err.code === 4001 || /user rejected|denied/i.test(err.message ?? "")) return "You declined the request in your wallet.";
  if (/insufficient funds/i.test(err.message ?? "")) return "Not enough MON for gas. Use the MON faucet link below.";
  if (/exceeds balance|transfer amount exceeds/i.test(err.message ?? "")) return "Not enough AUSD. Use the Get 10,000 test AUSD button below.";
  if (/NotAccepting/.test(err.message ?? "")) return "This curator is not accepting subscribers.";
  return err.shortMessage ?? err.message?.split("\n")[0] ?? "Something went wrong.";
}
