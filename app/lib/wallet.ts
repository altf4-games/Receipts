"use client";
import { useEffect } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, type Address, type EIP1193Provider } from "viem";
import { CHAIN_ID, RPC_URL } from "./config";

export const monad = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
});

let override: EIP1193Provider | null = null; // set by the Privy bridge while someone is signed in with an embedded wallet
let loginHandler: (() => void) | null = null; // opens Privy's sign-in dialog; set only when Privy is configured
export function setProviderOverride(p: EIP1193Provider | null) {
  override = p;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("receipts:provider"));
}
export function setLoginHandler(fn: (() => void) | null) { loginHandler = fn; }

/** The wallet in use: the Privy embedded wallet while signed in, otherwise a browser extension wallet. */
export function provider(): EIP1193Provider | null {
  if (override) return override;
  return typeof window === "undefined" ? null : ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null);
}

function waitForEmbedded(): Promise<EIP1193Provider> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { window.removeEventListener("receipts:provider", on); reject(new Error("Sign-in was not completed.")); }, 5 * 60_000);
    const on = () => { if (override) { clearTimeout(t); window.removeEventListener("receipts:provider", on); resolve(override); } };
    window.addEventListener("receipts:provider", on);
  });
}

export async function connect(): Promise<Address> {
  let p = provider();
  if (!p && loginHandler) { loginHandler(); p = await waitForEmbedded(); } // no extension wallet: sign in with Google or email instead
  if (!p) throw new Error("No browser wallet found. Install MetaMask or another EIP-1193 wallet.");
  const embedded = p === override;
  const accounts = (await p.request({ method: embedded ? "eth_accounts" : "eth_requestAccounts" })) as Address[];
  if (!accounts[0]) throw new Error("No account available. Sign in again.");
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }] });
  } catch (e) {
    if (embedded) return accounts[0]; // the embedded wallet was already switched to Monad when it was created
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
  if (/insufficient funds|insufficient balance|signer had insufficient/i.test(err.message ?? "")) return "Not enough MON for gas. Use the MON faucet link below.";
  if (/exceeds balance|transfer amount exceeds/i.test(err.message ?? "")) return "Not enough AUSD. Use the Get 10,000 test AUSD button below.";
  if (/NotAccepting/.test(err.message ?? "")) return "This curator is not accepting subscribers.";
  return err.shortMessage ?? err.message?.split("\n")[0] ?? "Something went wrong.";
}

/** True while a Privy embedded wallet is signed in. */
export const hasEmbedded = () => override !== null;

/** Connects automatically once someone signs in with the embedded wallet, so there is no second "Connect wallet" click. */
export function useAutoConnect(connected: boolean, onConnect: () => void) {
  useEffect(() => {
    if (connected) return;
    const on = () => { if (override) onConnect(); };
    on();
    window.addEventListener("receipts:provider", on);
    return () => window.removeEventListener("receipts:provider", on);
    // onConnect is recreated every render; the effect only needs to re-run when the connected state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
}
