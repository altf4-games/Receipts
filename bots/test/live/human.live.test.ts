/**
 * LIVE: the keeper's treatment of HUMAN curators' calls on STAGING (Monad testnet). Real txs, real Perpl oracle.
 *  - human A commits, reveals and does nothing else: a keeper tick must SETTLE it after the horizon (score inside its own bounds)
 *  - human B commits and never reveals: a keeper tick must EXPIRE it (-30% penalty) and free the slot
 * Found by the first real production call (#19): before this fix nothing settled or expired a human's call.
 */
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createWalletClient, encodeAbiParameters, http, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import callAbi from "../../src/abi/CallRegistry.json" with { type: "json" };
import { buildNodeCtx, repoRoot } from "../../src/node.js";
import { Status, tickAll, type Call } from "../../src/tick.js";

const LOG = path.join(repoRoot, "docs", "bot-logs", `live-human-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const CALL = callAbi as Abi;
const SOL = 48n, ETH = 32n;

function fresh() {
  const { ctx, bots } = buildNodeCtx("staging", LOG);
  ctx.cadence = { periodSecs: 3600, windowSecs: 0 }; // no organic bot commits
  ctx.opts = { forceCommit: false };
  return { ctx, bots };
}

describe.sequential("HUMAN curators' calls are settled / expired by the keeper (staging)", () => {
  const { ctx, bots } = fresh();
  const reg = ctx.deployment.callRegistry;
  const A = privateKeyToAccount(process.env.TESTER_CURATOR_PRIVATE_KEY as Hex);
  const B = privateKeyToAccount(process.env.TESTER_SUBSCRIBER_PRIVATE_KEY as Hex);
  const wc = (acc: typeof A) => createWalletClient({ account: acc, chain: ctx.pc.chain, transport: http() });
  const openId = async (who: Address, perp: bigint) => (await ctx.pc.readContract({ address: reg, abi: CALL, functionName: "openCallId", args: [who, perp] })) as bigint;
  const getCall = async (id: bigint) => (await ctx.pc.readContract({ address: reg, abi: CALL, functionName: "getCall", args: [id] })) as unknown as Call;
  const hashOf = (who: Address, perp: bigint, dir: number, tp: number, sl: number, h: number, salt: Hex) =>
    keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" }],
      [10143n, reg, who, perp, dir, tp, sl, h, salt]));
  const write = async (acc: typeof A, fn: string, args: unknown[]) => {
    const est = await ctx.pc.estimateContractGas({ account: acc, address: reg, abi: CALL, functionName: fn, args } as never);
    const hash = await wc(acc).writeContract({ address: reg, abi: CALL, functionName: fn, args, gas: (est * 12n) / 10n } as never);
    const rc = await ctx.pc.waitForTransactionReceipt({ hash });
    expect(rc.status).toBe("success");
    return hash;
  };
  let idA = 0n, idB = 0n;
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;

  test("setup: both human wallets have a free slot, then commit (A reveals at once, B never reveals)", async () => {
    expect(await openId(A.address, SOL), "TESTER_CURATOR has an open SOL call").toBe(0n);
    expect(await openId(B.address, ETH), "TESTER_SUBSCRIBER has an open ETH call").toBe(0n);
    await write(A, "commit", [SOL, hashOf(A.address, SOL, 1, 100, 100, 60, salt), 60]);
    await write(B, "commit", [ETH, hashOf(B.address, ETH, 2, 100, 100, 60, salt), 60]);
    idA = await openId(A.address, SOL);
    idB = await openId(B.address, ETH);
    expect(idA).toBeGreaterThan(0n);
    expect(idB).toBeGreaterThan(0n);
    await write(A, "reveal", [idA, 1, 100, 100, salt]);
    expect((await getCall(idA)).status).toBe(Status.Revealed);
    console.log(`[human] A call ${idA} (revealed), B call ${idB} (sealed, never revealed)`);
  }, 120_000);

  test("keeper ticks (fresh context each time): A is Settled inside its own bounds, B is Expired at -3000", async () => {
    const events: Record<string, unknown>[] = [];
    const deadline = Date.now() + 6 * 60_000;
    let a = await getCall(idA), b = await getCall(idB);
    while (Date.now() < deadline && !(a.status === Status.Settled && b.status === Status.Expired)) {
      const f = fresh();
      const inner = f.ctx.log;
      f.ctx.log = (e) => { events.push(e); inner(e); };
      await tickAll(f.ctx, f.bots);
      await new Promise((r) => setTimeout(r, 5000));
      a = await getCall(idA); b = await getCall(idB);
    }
    expect(a.status).toBe(Status.Settled);
    expect(a.scoreBps).toBeGreaterThanOrEqual(-100);
    expect(a.scoreBps).toBeLessThanOrEqual(100);
    expect(a.flags & 1).toBe(1); // v1 settles on the endpoint: flagged APPROX
    expect(b.status).toBe(Status.Expired);
    expect(b.scoreBps).toBe(-3000);
    // the slots are free again
    expect(await openId(A.address, SOL)).toBe(0n);
    expect(await openId(B.address, ETH)).toBe(0n);
    const human = events.filter((e) => e.human);
    expect(human.some((e) => e.evt === "settle" && e.status === "success")).toBe(true);
    expect(human.some((e) => e.evt === "expire" && e.status === "success")).toBe(true);
    console.log(`[human] A settled score ${a.scoreBps} bps; B expired ${b.scoreBps} bps; events ${JSON.stringify(human.filter((e) => e.hash).map((e) => ({ evt: e.evt, hash: e.hash })))}`);
    void bots;
  }, 420_000);
});
