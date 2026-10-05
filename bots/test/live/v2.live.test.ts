/**
 * LIVE: the keeper's SettlerV2 fallback on STAGING-V2 (Monad testnet). Nobody runs the CRE CLI here: a fresh keeper tick
 * must record the endpoint sample, propose the deciding sample from the tape, and finalize after the dispute window,
 * and the final score must equal an independent recomputation from the tape. Real txs, real Perpl oracle.
 */
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createWalletClient, encodeAbiParameters, http, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import callAbi from "../../src/abi/CallRegistry.json" with { type: "json" };
import tapeAbi from "../../src/abi/PriceTape.json" with { type: "json" };
import { buildNodeCtx, repoRoot } from "../../src/node.js";
import { Status, tickAll, type Call } from "../../src/tick.js";

const LOG = path.join(repoRoot, "docs", "bot-logs", `live-v2-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const CALL = callAbi as Abi, TAPE = tapeAbi as Abi;
const ETH = 32n;

function fresh() {
  const { ctx, bots } = buildNodeCtx("staging-v2", LOG);
  ctx.cadence = { periodSecs: 3600, windowSecs: 0 }; // no organic bot commits
  ctx.opts = { forceCommit: false };
  return { ctx, bots };
}

describe.sequential("SettlerV2 keeper fallback (staging-v2): sample -> propose -> finalize without CRE", () => {
  const { ctx } = fresh();
  const reg = ctx.deployment.callRegistry, tape = ctx.deployment.priceTape as Address;
  const A = privateKeyToAccount(process.env.TESTER_CURATOR_PRIVATE_KEY as Hex);
  const wc = createWalletClient({ account: A, chain: ctx.pc.chain, transport: http() });
  const rd = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) => ctx.pc.readContract({ address, abi, functionName, args } as never);
  const getCall = async (id: bigint) => (await rd(reg, CALL, "getCall", [id])) as unknown as Call;
  const write = async (fn: string, args: unknown[], address: Address = reg, abi: Abi = CALL) => {
    const est = await ctx.pc.estimateContractGas({ account: A, address, abi, functionName: fn, args } as never);
    const hash = await wc.writeContract({ address, abi, functionName: fn, args, gas: (est * 12n) / 10n } as never);
    expect((await ctx.pc.waitForTransactionReceipt({ hash })).status).toBe("success");
    return hash;
  };
  const salt = keccak256(toHex(crypto.randomUUID())) as Hex;
  let id = 0n;

  test("setup: a human call (ETH LONG tp/sl 1 bp, 150 s) is committed and revealed; the path is recorded by the curator", async () => {
    expect(await rd(reg, CALL, "openCallId", [A.address, ETH]), "TESTER_CURATOR has an open ETH call on staging-v2").toBe(0n);
    const hash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" }],
      [10143n, reg, A.address, ETH, 1, 1, 1, 150, salt]));
    await write("commit", [ETH, hash, 150]);
    id = (await rd(reg, CALL, "openCallId", [A.address, ETH])) as bigint;
    await write("reveal", [id, 1, 1, 1, salt]);
    expect((await getCall(id)).status).toBe(Status.Revealed);
    const end = (await getCall(id)).horizonEnd;
    while ((await ctx.pc.getBlock()).timestamp < end) { await write("sample", [[ETH]], tape, TAPE); await new Promise((r) => setTimeout(r, 25_000)); }
    console.log(`[v2-keeper] call ${id} revealed; path recorded; horizon ${end}`);
  }, 400_000);

  test("keeper ticks (fresh context each time) record the endpoint, propose, and finalize; score == independent recomputation", async () => {
    const events: Record<string, unknown>[] = [];
    const deadline = Date.now() + 8 * 60_000;
    let c = await getCall(id);
    while (Date.now() < deadline && c.status !== Status.Settled) {
      const f = fresh();
      const inner = f.ctx.log;
      f.ctx.log = (e) => { events.push(e); inner(e); };
      await tickAll(f.ctx, f.bots);
      await new Promise((r) => setTimeout(r, 8000));
      c = await getCall(id);
    }
    expect(c.status).toBe(Status.Settled);
    expect(c.flags & 4).toBe(4); // scored from the tape
    // independent reference from the tape contents
    const n = (await rd(tape, TAPE, "sampleCount", [ETH])) as bigint;
    const samples: { ts: bigint; price: bigint }[] = [];
    for (let i = 0n; i < n; i++) samples.push((await rd(tape, TAPE, "sampleAt", [ETH, i])) as { ts: bigint; price: bigint });
    const ret = (p: bigint) => ((p - c.entryPNS) * 10_000n) / c.entryPNS; // long
    const path = samples.filter((s) => s.ts > c.entryOracleTs && s.ts < c.horizonEnd);
    const touch = path.find((s) => ret(s.price) >= 1n || ret(s.price) <= -1n);
    const endpoint = samples.find((s) => s.ts >= c.horizonEnd)!;
    const expected = touch ? (ret(touch.price) >= 1n ? 1n : -1n) : ret(endpoint.price) < -1n ? -1n : ret(endpoint.price) > 1n ? 1n : ret(endpoint.price);
    expect(BigInt(c.scoreBps)).toBe(expected);
    const ev = (name: string) => events.filter((e) => e.evt === name && e.hash);
    expect(ev("v2_propose").length, "the keeper never proposed").toBeGreaterThanOrEqual(1);
    expect(ev("v2_finalize").length, "the keeper never finalized").toBeGreaterThanOrEqual(1);
    console.log(`[v2-keeper] settled ${c.scoreBps} bps (touch ${touch ? "yes" : "no"}); ${JSON.stringify(events.filter((e) => String(e.evt).startsWith("v2_") && e.hash).map((e) => ({ evt: e.evt, hash: e.hash })))}`);
  }, 600_000);
});
