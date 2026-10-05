"use client";
import { useState } from "react";
import { isAddress, parseAbi, type Address, type Hex } from "viem";
import { DEPLOYMENTS, EXPLORER, type DeploymentName } from "@/lib/config";
import { clients, connect, humanError, monad } from "@/lib/wallet";

const abi = parseAbi([
  "function identityMessage(address curator, uint256 nonce) view returns (string)",
  "function identityNonce(address curator) view returns (uint256)",
  "function linkIdentity(address wallet, bytes signature)",
  "function linkedWallets(address curator) view returns (address[])",
]);

/**
 * Link a mainnet identity wallet to your curator. The identity wallet must sign a message that names your curator address, so
 * nobody can attach a wallet that is not theirs. Nansen then reads that wallet on Monad mainnet (PnL, related wallets, clusters).
 * The same address works on both chains, so linking your own address is the one-click path.
 */
export function LinkIdentity({ dep }: { dep: DeploymentName }) {
  const reg = DEPLOYMENTS[dep].curatorRegistry;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);
  const [curator, setCurator] = useState("");
  const [sig, setSig] = useState("");
  const [wallet, setWallet] = useState("");
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); setMsg(null); try { await fn(); } catch (e) { setError(humanError(e)); } finally { setBusy(false); } };

  const sign = async (acct: Address, forCurator: Address) => {
    const { pub, wallet: w } = clients(acct);
    const nonce = await pub.readContract({ address: reg, abi, functionName: "identityNonce", args: [forCurator] });
    const text = await pub.readContract({ address: reg, abi, functionName: "identityMessage", args: [forCurator, nonce] });
    return w.signMessage({ account: acct, message: text });
  };
  const send = async (acct: Address, identity: Address, signature: Hex) => {
    const { pub, wallet: w } = clients(acct);
    const hash = await w.writeContract({ address: reg, abi, functionName: "linkIdentity", args: [identity, signature], account: acct, chain: monad } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    setTx(hash);
    if (r.status !== "success") throw new Error("The transaction reverted.");
  };

  const btn = "border-2 px-3 py-2 font-bold disabled:opacity-50";
  return (
    <section className="slip mt-6 text-sm" aria-label="Link a mainnet identity wallet">
      <div className="font-bold">Link a mainnet identity (for Nansen)</div>
      <hr />
      <p className="dim">Curators only. Nansen has no testnet data, so it reads the wallet you link on Monad mainnet: realised PnL, related wallets, and a flag if two curators turn out to share an operator. The linked wallet signs a message naming your curator address; nobody can link a wallet they do not control.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={btn} style={{ borderColor: "var(--paper-ink)" }} disabled={busy} onClick={() => run(async () => {
          const a = await connect();
          const signature = await sign(a, a);
          await send(a, a, signature);
          setMsg(`Linked ${a} to your curator.`);
        })}>{busy ? "Working…" : "Link my own address"}</button>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer underline">Link a different wallet (two steps)</summary>
        <div className="mt-2">
          <div className="font-bold">1. Connected as the identity wallet</div>
          <label className="block text-xs dim" htmlFor="li-curator">Curator address to link to</label>
          <input id="li-curator" className="w-full border bg-transparent px-2 py-1" value={curator} onChange={(e) => setCurator(e.target.value.trim())} placeholder="0x…" />
          <button className={`${btn} mt-2`} style={{ borderColor: "var(--paper-ink)" }} disabled={busy || !isAddress(curator)} onClick={() => run(async () => {
            const a = await connect();
            setSig(await sign(a, curator as Address)); setWallet(a);
            setMsg("Signed. Switch your wallet to the curator account and finish step 2.");
          })}>Sign as this wallet</button>
          <div className="mt-4 font-bold">2. Connected as the curator</div>
          <label className="block text-xs dim" htmlFor="li-wallet">Identity wallet</label>
          <input id="li-wallet" className="w-full border bg-transparent px-2 py-1" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} placeholder="0x…" />
          <label className="block text-xs dim" htmlFor="li-sig">Signature</label>
          <input id="li-sig" className="w-full break-all border bg-transparent px-2 py-1" value={sig} onChange={(e) => setSig(e.target.value.trim())} placeholder="0x…" />
          <button className={`${btn} mt-2`} style={{ borderColor: "var(--paper-ink)" }} disabled={busy || !isAddress(wallet) || !/^0x[0-9a-fA-F]{130}$/.test(sig)} onClick={() => run(async () => {
            const a = await connect();
            await send(a, wallet as Address, sig as Hex);
            setMsg(`Linked ${wallet} to ${a}.`);
          })}>Link</button>
        </div>
      </details>
      {msg && <p role="status" className="mt-3">{msg}{tx && <> <a className="underline" href={`${EXPLORER}/tx/${tx}`}>transaction</a></>}</p>}
      {error && <p role="alert" className="mt-3" style={{ color: "var(--stamp-red)" }}>{error}</p>}
    </section>
  );
}
