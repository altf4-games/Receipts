"use client";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import Link from "next/link";
import { useEffect } from "react";
import { CHAIN_ID } from "@/lib/config";
import { setLoginHandler, setProviderOverride, monad } from "@/lib/wallet";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

/** Hands the Privy embedded wallet's EIP-1193 provider to the rest of the app, so every flow works the same with or without an extension. */
function Bridge() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  useEffect(() => { setLoginHandler(() => login()); return () => setLoginHandler(null); }, [login]);
  useEffect(() => {
    let off = false;
    (async () => {
      if (!ready) return;
      const w = authenticated ? wallets.find((x) => x.walletClientType === "privy") : undefined;
      if (!w) { setProviderOverride(null); return; }
      try { await w.switchChain(CHAIN_ID); } catch { /* the chain is also the default chain, so a failed switch is not fatal */ }
      const p = await w.getEthereumProvider();
      if (!off) setProviderOverride(p as unknown as Parameters<typeof setProviderOverride>[0]);
    })();
    return () => { off = true; };
  }, [ready, authenticated, wallets]);
  return null;
}

/** Wraps the app in Privy (email sign-in with an embedded wallet) when NEXT_PUBLIC_PRIVY_APP_ID is set; otherwise renders the app unchanged. */
export function PrivyRoot({ children }: { children: React.ReactNode }) {
  if (!APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["email"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: monad,
        supportedChains: [monad],
        appearance: { theme: "dark", accentColor: "#c8321f" },
      }}
    >
      <Bridge />
      {children}
    </PrivyProvider>
  );
}

function AuthInner() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  if (!ready) return <span className="dim" aria-hidden>…</span>;
  if (!authenticated) return <button onClick={() => login()} className="underline whitespace-nowrap">Sign in</button>;
  const who = user?.google?.email ?? user?.email?.address ?? "signed in";
  return <><Link href="/me" className="underline whitespace-nowrap">Test money</Link><button onClick={() => logout()} className="underline whitespace-nowrap" title={`Signed in as ${who}`}>Sign out</button></>;
}

export function AuthButton() {
  return APP_ID ? <AuthInner /> : null;
}
