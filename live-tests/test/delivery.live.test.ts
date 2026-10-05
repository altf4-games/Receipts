/**
 * LIVE suite L8 for the delivery API: the DEPLOYED Vercel app (real Upstash store) against the STAGING contracts.
 * A non-subscriber is denied, a subscriber gets plaintext that verifies against the on-chain hash, tampered plaintext
 * fails verification, a replayed/expired signature is refused, and a revealed call becomes public.
 * Run alone: pnpm exec vitest run test/delivery.live.test.ts
 */
import { beforeAll, describe, expect, test } from "vitest";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import {
  AUSD, abis, deployment, erc20Abi, publicClient, record, send, sleep, wallet, waitUntilTimestamp,
} from "../src/chain.js";

const APP = process.env.APP_URL ?? "https://receipts-app-rho-ashy.vercel.app";
const Q = "?deployment=staging";
const CR = deployment.callRegistry;
const SUBS = deployment.subscriptions as Address;
const CURATOR = wallet("TESTER_CURATOR");
const SUBSCRIBER = wallet("TESTER_SUBSCRIBER");
const STRANGER = wallet("KEEPER");
const BTC = 16n;
const RATE = 10_000n;

const msg = (id: number | bigint, ts: number) => `Receipts: read call ${id} on staging at ${ts}`;
const rnd = () => keccak256(toHex(crypto.randomUUID())) as Hex;
function localHash(curator: Address, perp: bigint, dir: number, tp: number, sl: number, horizon: number, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" }],
    [10143n, CR, curator, perp, dir, tp, sl, horizon, salt]));
}
async function get(id: bigint, who?: typeof SUBSCRIBER, opts: { ts?: number; signFor?: bigint } = {}) {
  const headers: Record<string, string> = {};
  if (who) {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    headers["x-receipts-address"] = who.account.address;
    headers["x-receipts-timestamp"] = String(ts);
    headers["x-receipts-signature"] = await who.account.signMessage({ message: msg(opts.signFor ?? id, ts) });
  }
  const r = await fetch(`${APP}/api/calls/${id}${Q}`, { headers });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const post = async (body: unknown) => {
  const r = await fetch(`${APP}/api/calls${Q}`, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

describe("L8 delivery API (deployed app, staging contracts)", () => {
  let id = 0n;
  const plain = { perpId: 16, direction: 1, tpBps: 100, slBps: 100, horizonSecs: 90, salt: rnd() };

  beforeAll(async () => {
    const open = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [CURATOR.account.address, BTC] })) as bigint;
    expect(open, "TESTER_CURATOR has an open BTC call; let the other live suite clear it first").toBe(0n);
    // make sure no leftover stream, then commit a sealed call
    const s = (await publicClient.readContract({ address: SUBS, abi: abis.subscriptions, functionName: "getStream", args: [CURATOR.account.address, SUBSCRIBER.account.address] })) as { deposit: bigint };
    if (s.deposit !== 0n) await send(SUBSCRIBER, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address]);
    const hash = localHash(CURATOR.account.address, BTC, plain.direction, plain.tpBps, plain.slBps, plain.horizonSecs, plain.salt);
    const c = await send(CURATOR, CR, abis.call, "commit", [BTC, hash, plain.horizonSecs]);
    expect(c.receipt.status).toBe("success");
    id = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [CURATOR.account.address, BTC] })) as bigint;
    record("L8.commit", { id, tx: c.hash });
    await send(SUBSCRIBER, AUSD, erc20Abi, "approve", [SUBS, 2n ** 256n - 1n]);
  }, 300_000);

  test("upload: wrong plaintext is rejected, right plaintext stored", async () => {
    const bad = await post({ callId: Number(id), ...plain, tpBps: 101 });
    expect(bad.status).toBe(422);
    const garbage = await post({ callId: Number(id), ...plain, salt: "0x12" });
    expect(garbage.status).toBe(400);
    const unknown = await post({ callId: 99999999, ...plain });
    expect(unknown.status).toBe(404);
    const ok = await post({ callId: Number(id), ...plain });
    expect(ok.status).toBe(200);
    expect(ok.body.hash).toBe(((await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as { hash: Hex }).hash);
  }, 60_000);

  test("non-subscribers are denied (no signature, stranger, signed but not subscribed)", async () => {
    expect((await get(id)).status).toBe(401);
    expect((await get(id, STRANGER)).status).toBe(403);
    expect((await get(id, SUBSCRIBER)).status).toBe(403); // valid signature, no stream yet
  }, 60_000);

  test("subscriber gets the plaintext; it verifies against the on-chain hash; tampering fails; replay and expiry refused", async () => {
    const sub = await send(SUBSCRIBER, SUBS, abis.subscriptions, "subscribe", [CURATOR.account.address, RATE * 120n]);
    expect(sub.receipt.status).toBe("success");
    record("L8.subscribe", { tx: sub.hash });
    const r = await get(id, SUBSCRIBER);
    expect(r.status).toBe(200);
    const p = r.body.plaintext;
    const onchain = ((await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as { hash: Hex }).hash;
    expect(r.body.onchainHash).toBe(onchain);
    // client-side verification, exactly what the browser does
    expect(localHash(r.body.curator, BigInt(p.perpId), p.direction, p.tpBps, p.slBps, p.horizonSecs, p.salt)).toBe(onchain);
    expect(localHash(r.body.curator, BigInt(p.perpId), 2, p.tpBps, p.slBps, p.horizonSecs, p.salt)).not.toBe(onchain); // flipped direction
    expect(localHash(r.body.curator, BigInt(p.perpId), p.direction, p.tpBps + 1, p.slBps, p.horizonSecs, p.salt)).not.toBe(onchain);
    // expired and cross-call-replayed signatures
    expect((await get(id, SUBSCRIBER, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await get(id, SUBSCRIBER, { signFor: id + 1n })).status).toBe(401);
    // after the stream ends access stops (cancel = exact refund path already covered in L7)
    const c = await send(SUBSCRIBER, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address]);
    expect(c.receipt.status).toBe("success");
    expect((await get(id, SUBSCRIBER)).status).toBe(403);
    record("L8.cancelled", { tx: c.hash });
  }, 120_000);

  test("after reveal the call is public; cleanup settles it", async () => {
    const rv = await send(CURATOR, CR, abis.call, "reveal", [id, plain.direction, plain.tpBps, plain.slBps, plain.salt]);
    expect(rv.receipt.status).toBe("success");
    const pub = await get(id);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe(2);
    record("L8.public", { reveal: rv.hash });
    // free the slot for the next run
    const call = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as { horizonEnd: bigint };
    await waitUntilTimestamp(call.horizonEnd);
    for (let i = 0; i < 40; i++) {
      try {
        const s = await send(STRANGER, deployment.settlerV1, abis.settler, "settle", [id]);
        if (s.receipt.status === "success") { record("L8.settled", { tx: s.hash }); return; }
      } catch { /* oracle sample not fresh enough yet */ }
      await sleep(5000);
    }
    throw new Error("could not settle the L8 call");
  }, 400_000);
});
