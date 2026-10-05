/**
 * TEST-ONLY wallet for browser checks: a local EIP-1193-over-HTTP signer backed by a STAGING test key from .env
 * (TESTER_SUBSCRIBER). Real signatures, real transactions on Monad testnet; nothing is mocked. Listens on 127.0.0.1 only.
 */
import http from "node:http";
import { createPublicClient, createWalletClient, http as vhttp, hexToString, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet, wallet } from "../src/chain.js";

// FRESH=1 uses a brand-new random testnet key kept only in memory (to test first-time registration).
const W = process.env.FRESH ? { account: privateKeyToAccount(generatePrivateKey()) } : wallet(process.env.WALLET ?? "TESTER_SUBSCRIBER");
const pub = createPublicClient({ chain: monadTestnet, transport: vhttp() });
const wc = createWalletClient({ account: W.account, chain: monadTestnet, transport: vhttp() });

async function handle(method: string, params: any[]): Promise<unknown> {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts": return [W.account.address];
    case "eth_chainId": return "0x" + (10143).toString(16);
    case "wallet_switchEthereumChain": return null;
    case "personal_sign": {
      const msg = hexToString(params[0] as Hex);
      return W.account.signMessage({ message: msg });
    }
    case "eth_sendTransaction": {
      const t = params[0];
      return wc.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined });
    }
    default: return (pub.transport as any).request({ method, params });
  }
}
http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", async () => {
    try {
      const { method, params } = JSON.parse(b);
      const result = await handle(method, params ?? []);
      res.end(JSON.stringify({ result: result ?? null }));
    } catch (e: any) {
      res.statusCode = 200;
      res.end(JSON.stringify({ error: { code: e?.code ?? -32000, message: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) } }));
    }
  });
}).listen(8787, "127.0.0.1", () => console.log("dev-wallet listening", W.account.address));
