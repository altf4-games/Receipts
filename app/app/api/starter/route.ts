import { NextResponse } from "next/server";
import { createWalletClient, erc20Abi, http, isAddress, parseAbi, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { client, monadTestnet } from "@/lib/calls";
import { ADDR, AUSD_FAUCET, RPC_URL } from "@/lib/config";
import { redis } from "@/lib/delivery";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/starter {address}: sends a little testnet MON (gas) and test AUSD to a new wallet so a first-time visitor can
 * try the app without hunting for faucets. Testnet money from a dedicated wallet (never a protocol key), once per address,
 * a few per IP per day, and a global daily cap.
 */
const MON_GRANT = parseEther("0.25");
const AUSD_GRANT = BigInt(200_000_000); // 200 AUSD (6 decimals)
const MON_ENOUGH = parseEther("0.15");
const AUSD_ENOUGH = BigInt(100_000_000);
const PER_IP_PER_DAY = 3;
const GLOBAL_PER_DAY = 40;
const faucetAbi = parseAbi(["function requestFunds(address to)"]);

export async function POST(req: Request) {
  const pk = process.env.STARTER_PRIVATE_KEY;
  if (!pk) return NextResponse.json({ error: "Starter funds are not configured on this deployment." }, { status: 503 });
  let address: string | undefined;
  try { address = ((await req.json()) as { address?: string }).address; } catch { /* handled below */ }
  if (!address || !isAddress(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
  const to = address as Address;

  const bal = await Promise.all([
    client.getBalance({ address: to }),
    client.readContract({ address: ADDR.ausd, abi: erc20Abi, functionName: "balanceOf", args: [to] }),
  ]);
  const needMon = bal[0] < MON_ENOUGH, needAusd = bal[1] < AUSD_ENOUGH;
  if (!needMon && !needAusd) return NextResponse.json({ status: "already-funded", mon: bal[0].toString(), ausd: bal[1].toString() });

  const day = new Date().toISOString().slice(0, 10);
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0]!.trim();
  const ipKey = `starter:ip:${ip}:${day}`, dayKey = `starter:day:${day}`, addrKey = `starter:addr:${to.toLowerCase()}`;
  if ((await redis.get<string>(addrKey)) !== null) return NextResponse.json({ error: "This wallet already received starter funds. The Agora faucet (button below) can top up AUSD." }, { status: 429 });
  if ((await redis.incr(ipKey)) > PER_IP_PER_DAY) return NextResponse.json({ error: "Too many requests from this network today." }, { status: 429 });
  await redis.expire(ipKey, 86_400);
  if ((await redis.incr(dayKey)) > GLOBAL_PER_DAY) return NextResponse.json({ error: "Today's starter funds are used up. Try the faucets linked below." }, { status: 429 });
  await redis.expire(dayKey, 86_400);
  if (!(await redis.set("starter:lock", "1", { nx: true, ex: 40 }))) return NextResponse.json({ error: "Busy, try again in a few seconds." }, { status: 429 });

  try {
    const account = privateKeyToAccount(pk as `0x${string}`);
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC_URL) });
    const hashes: Record<string, string> = {};
    // top the funding wallet's own AUSD up from the Agora faucet when it runs low
    const own = await client.readContract({ address: ADDR.ausd, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (own < BigInt(1_000_000_000)) {
      const h = await wallet.writeContract({ address: AUSD_FAUCET, abi: faucetAbi, functionName: "requestFunds", args: [account.address], gas: BigInt(200_000) });
      await client.waitForTransactionReceipt({ hash: h });
    }
    if (needMon) {
      const h = await wallet.sendTransaction({ to, value: MON_GRANT, gas: BigInt(21_000) });
      hashes.mon = h;
      const r = await client.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error("MON transfer reverted");
    }
    if (needAusd) {
      const h = await wallet.writeContract({ address: ADDR.ausd, abi: erc20Abi, functionName: "transfer", args: [to, AUSD_GRANT], gas: BigInt(120_000) });
      hashes.ausd = h;
      const r = await client.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error("AUSD transfer reverted");
    }
    await redis.set(addrKey, "1", { ex: 30 * 86_400 });
    return NextResponse.json({ status: "sent", mon: needMon ? MON_GRANT.toString() : "0", ausd: needAusd ? AUSD_GRANT.toString() : "0", tx: hashes });
  } catch (e) {
    await redis.decr(dayKey); await redis.decr(ipKey);
    return NextResponse.json({ error: (e as Error).message.split("\n")[0] }, { status: 502 });
  } finally {
    await redis.del("starter:lock");
  }
}
