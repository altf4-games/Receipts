/**
 * LIVE suite for Phase 4 (price tape + SettlerV2) against the STAGING-V2 deployment on Monad testnet.
 * Real txs, real Perpl oracle, real AUSD. Run alone:  DEPLOY_NAME=staging-v2 pnpm exec vitest run test/tape.live.test.ts
 *  - the tape stores exactly what the Exchange's oracle says (independent raw decode)
 *  - a forged report (non-forwarder) is refused by both receivers
 *  - a real call is scored from the tape: the on-chain score equals an independent TypeScript recomputation, with
 *    the deliberately-wrong-proposal + dispute path exercised whenever a real TP/SL touch occurred in the window
 */
import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import {
  AUSD, EXCHANGE, FAUCET, abis, deployment, erc20Abi, faucetAbi, publicClient, rawOracleAt, record, send, simulateRevert, sleep, wallet,
  waitUntilTimestamp,
} from "../src/chain.js";

const TAPE = deployment.priceTape as Address;
const V2 = deployment.settlerV2 as Address;
const CR = deployment.callRegistry;
const CU = deployment.curatorRegistry;
const WINDOW = BigInt(deployment.disputeWindow ?? 60);
const BTC = 16n;
const CRE_BIN = process.env.CRE_BIN ?? path.join(os.homedir(), ".cre", "bin", "cre");
const CRE_DIR = path.join(path.resolve(import.meta.dirname, "../.."), "cre");
const A = wallet("TESTER_CURATOR");
const KEEPER = wallet("KEEPER");
const STRANGER = wallet("TESTER_SUBSCRIBER");

type Sample = { ts: bigint; blockNumber: bigint; price: bigint };
type Call = { status: number; direction: number; tpBps: number; slBps: number; scoreBps: number; flags: number; horizonEnd: bigint; entryOracleTs: bigint; entryPNS: bigint; priceDecimals: number; horizonSecs: number };
const rdTape = (fn: string, args: unknown[]) => publicClient.readContract({ address: TAPE, abi: abis.tape, functionName: fn, args } as never);
const getCall = async (id: bigint) => (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as unknown as Call;
const sampleAt = async (i: bigint) => (await rdTape("sampleAt", [BTC, i])) as Sample;
const count = async () => (await rdTape("sampleCount", [BTC])) as bigint;
const rnd = () => keccak256(toHex(crypto.randomUUID())) as Hex;
function localHash(curator: Address, dir: number, tp: number, sl: number, horizon: number, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" }],
    [10143n, CR, curator, BTC, dir, tp, sl, horizon, salt]));
}
/** return in bps, truncated toward zero (BigInt division does the same as Solidity), signed by direction */
const retBps = (c: Call, price: bigint) => {
  const raw = ((price - c.entryPNS) * 10_000n) / c.entryPNS;
  return c.direction === 2 ? -raw : raw;
};

async function ensureCurator() {
  const c = (await publicClient.readContract({ address: CU, abi: abis.curators, functionName: "getCurator", args: [A.account.address] })) as { registered: boolean };
  if (c.registered) return;
  const bal = (await publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [A.account.address] })) as bigint;
  if (bal < BigInt(deployment.minBond)) {
    for (let i = 0; ; i++) {
      try { const f = await send(A, FAUCET, faucetAbi, "requestFunds", [A.account.address]); if (f.receipt.status === "success") break; } catch (e) { if (i > 4) throw e; }
      await sleep(62_000);
    }
  }
  await send(A, AUSD, erc20Abi, "approve", [CU, BigInt(deployment.minBond)]);
  const r = await send(A, CU, abis.curators, "register", ["live-curator-v2", "", false, BigInt(deployment.minBond)]);
  expect(r.receipt.status).toBe("success");
  record("v2.register", { tx: r.hash });
}

describe.sequential("Phase 4 live (staging-v2): price tape + SettlerV2", () => {
  beforeAll(async () => {
    expect(deployment.name ?? process.env.DEPLOY_NAME).toBe("staging-v2");
    expect(((await publicClient.readContract({ address: CR, abi: abis.call, functionName: "settler" })) as string).toLowerCase()).toBe(V2.toLowerCase());
    await ensureCurator();
  }, 400_000);

  test("T1 the tape records exactly the Exchange's oracle (independent raw decode at the tx block or the one before)", async () => {
    const before = await count();
    let appended = false;
    for (let i = 0; i < 40 && !appended; i++) {
      const s = await send(KEEPER, TAPE, abis.tape, "sample", [[BTC]]);
      expect(s.receipt.status).toBe("success");
      if ((await count()) > before) {
        appended = true;
        const idx = (await count()) - 1n;
        const smp = await sampleAt(idx);
        // an oracle tick can land in the same block as our tx: accept the oracle at B-1 or B
        const b = s.receipt.blockNumber;
        const [o1, o0] = await Promise.all([rawOracleAt(BTC, b - 1n), rawOracleAt(BTC, b)]);
        const match = (o: { price: bigint; ts: bigint }) => o.price === smp.price && o.ts === smp.ts;
        expect(match(o1) || match(o0), `tape ${smp.price}@${smp.ts} vs oracle B-1 ${o1.price}@${o1.ts}, B ${o0.price}@${o0.ts}`).toBe(true);
        expect(smp.blockNumber).toBe(b);
        record("tape.sampled", { tx: s.hash, index: idx, price: smp.price, oracleTs: smp.ts, matchedBlock: match(o0) ? "B" : "B-1" });
      } else await sleep(8000);
    }
    expect(appended, "no new oracle sample appeared in ~5 minutes").toBe(true);
  }, 400_000);

  test("T2 a forged report is refused: only the CRE forwarder may call onReport (tape and settler)", async () => {
    const tapeReport = encodeAbiParameters([{ type: "uint256[]" }, { type: "uint128[]" }], [[BTC], [999_999_999n]]);
    expect(await simulateRevert(STRANGER, TAPE, abis.tape, "onReport", ["0x", tapeReport])).toBe("NotForwarder");
    const setReport = encodeAbiParameters([{ type: "uint256[]" }, { type: "uint32[]" }], [[1n], [0]]);
    expect(await simulateRevert(STRANGER, V2, abis.settlerV2, "onReport", ["0x", setReport])).toBe("NotForwarder");
    expect(await simulateRevert(STRANGER, TAPE, abis.tape, "sample", [[999_999n]])).toMatch(/ContractDoesNotExist|unexpected|revert/); // unknown market
    record("v2.forged", { ok: true });
  }, 60_000);

  /**
   * One full lifecycle on staging-v2: commit -> reveal -> path samples -> endpoint sample -> PROPOSE (by the keeper wallet or
   * by the real CRE workflow via `cre workflow simulate --broadcast`) -> finalize, then compare the on-chain score with an
   * independent TypeScript recomputation from the tape contents.
   */
  async function lifecycle(proposer: "keeper" | "cre") {
    const open = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, BTC] })) as bigint;
    expect(open, "TESTER_CURATOR has an open BTC call on staging-v2").toBe(0n);
    const dir = 1, tp = 1, sl = 1, horizon = 150; // 1 bp each side: a real touch is likely within a few oracle ticks
    const salt = rnd();
    const commit = await send(A, CR, abis.call, "commit", [BTC, localHash(A.account.address, dir, tp, sl, horizon, salt), horizon]);
    expect(commit.receipt.status).toBe("success");
    const id = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, BTC] })) as bigint;
    const reveal = await send(A, CR, abis.call, "reveal", [id, dir, tp, sl, salt]);
    expect(reveal.receipt.status).toBe("success");
    const c = await getCall(id);
    record(`v2.call.${proposer}`, { id, commit: commit.hash, reveal: reveal.hash, entryPNS: c.entryPNS, entryTs: c.entryOracleTs, horizonEnd: c.horizonEnd });

    // anyone may record the path while the call runs (the CRE workflow does it on demand; here the keeper wallet does)
    while ((await publicClient.getBlock()).timestamp < c.horizonEnd) {
      await send(KEEPER, TAPE, abis.tape, "sample", [[BTC]]);
      await sleep(20_000);
    }
    let endpointIdx = -1n;
    for (let i = 0; i < 40 && endpointIdx < 0n; i++) {
      await send(KEEPER, TAPE, abis.tape, "sample", [[BTC]]);
      const idx = (await rdTape("firstIndexAtOrAfter", [BTC, c.horizonEnd])) as bigint;
      if (idx < (await count())) endpointIdx = idx; else await sleep(8000);
    }
    expect(endpointIdx).toBeGreaterThanOrEqual(0n);

    // independent reference from the tape contents
    const n = await count();
    const all: { i: bigint; s: Sample }[] = [];
    for (let i = 0n; i < n; i++) all.push({ i, s: await sampleAt(i) });
    const path = all.filter((x) => x.s.ts > c.entryOracleTs && x.s.ts < c.horizonEnd);
    const touch = path.find((x) => { const r = retBps(c, x.s.price); return r >= BigInt(tp) || r <= -BigInt(sl); });
    const endpoint = all[Number(endpointIdx)];
    expect(endpoint.s.ts).toBeGreaterThanOrEqual(c.horizonEnd);
    const clamp = (r: bigint) => (r < -BigInt(sl) ? -BigInt(sl) : r > BigInt(tp) ? BigInt(tp) : r);
    const expected = touch ? (retBps(c, touch.s.price) >= BigInt(tp) ? BigInt(tp) : -BigInt(sl)) : clamp(retBps(c, endpoint.s.price));
    const expectedIdx = touch ? touch.i : endpointIdx;
    console.log(`[v2/${proposer}] path samples ${path.length}, touch ${touch ? `at index ${touch.i} (${retBps(c, touch.s.price)} bps)` : "none"}, endpoint index ${endpointIdx} (${retBps(c, endpoint.s.price)} bps), expected score ${expected}`);

    // V1 is no longer the settler: it cannot close this call (it reverts inside registry.close with the registry's NotSettler error)
    expect(await simulateRevert(KEEPER, deployment.settlerV1, abis.settler, "settle", [id])).not.toBeUndefined();
    if (path.length) {
      const nonTouch = path.find((x) => x !== touch);
      if (nonTouch) expect(await simulateRevert(KEEPER, V2, abis.settlerV2, "propose", [id, nonTouch.i])).toBe("NotATouch");
    }

    let disputed = false;
    if (proposer === "cre") {
      const out = execFileSync(CRE_BIN, ["workflow", "simulate", "tape-and-settle", "--target", "staging-settings", "--broadcast", "--non-interactive", "--trigger-index", "0"], { cwd: CRE_DIR, encoding: "utf8", timeout: 240_000 });
      const m = /"settlerTx":"(0x[0-9a-f]{64})"/.exec(out.replace(/\\"/g, '"'));
      expect(m, "the CRE run did not report a settlerTx:\n" + out.slice(-1200)).not.toBeNull();
      const rc = await publicClient.waitForTransactionReceipt({ hash: m![1] as Hex });
      expect(rc.status).toBe("success");
      record("v2.cre.broadcast", { id, tx: m![1] });
      const prop = (await publicClient.readContract({ address: V2, abi: abis.settlerV2, functionName: "proposals", args: [id] })) as unknown as [bigint, number, number, boolean, boolean, boolean];
      expect(prop[0], "the CRE workflow did not create a proposal").toBeGreaterThan(0n);
      expect(BigInt(prop[1])).toBe(expectedIdx); // the workflow picked the same deciding sample as the independent reference
      expect(BigInt(prop[2])).toBe(expected);
    } else if (touch) {
      // deliberately wrong proposal (the endpoint, ignoring the real touch), then a dispute with the true first touch
      const p = await send(KEEPER, V2, abis.settlerV2, "propose", [id, endpointIdx]);
      expect(p.receipt.status).toBe("success");
      const d = await send(STRANGER, V2, abis.settlerV2, "dispute", [id, touch.i]);
      expect(d.receipt.status).toBe("success");
      disputed = true;
      record("v2.dispute", { id, propose: p.hash, dispute: d.hash, touchIndex: touch.i });
    } else {
      const p = await send(KEEPER, V2, abis.settlerV2, "propose", [id, endpointIdx]);
      expect(p.receipt.status).toBe("success");
      record("v2.propose", { id, propose: p.hash, note: "no TP/SL touch occurred in this window" });
    }
    expect(await simulateRevert(KEEPER, V2, abis.settlerV2, "finalize", [id])).toBe("WindowOpen");
    const prop = (await publicClient.readContract({ address: V2, abi: abis.settlerV2, functionName: "proposals", args: [id] })) as unknown as [bigint, ...unknown[]];
    await waitUntilTimestamp(prop[0] + WINDOW);
    const f = await send(KEEPER, V2, abis.settlerV2, "finalize", [id]);
    expect(f.receipt.status).toBe("success");
    record(`v2.finalize.${proposer}`, { id, tx: f.hash });

    const done = await getCall(id);
    expect(done.status).toBe(3); // Settled
    expect(BigInt(done.scoreBps)).toBe(expected);
    const lateFlag = endpoint.s.ts - c.horizonEnd > 180n && !touch ? 2 : 0;
    expect(done.flags).toBe(4 | (disputed ? 8 : 0) | lateFlag);
    expect(await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [A.account.address, BTC] })).toBe(0n);
    expect(await simulateRevert(KEEPER, V2, abis.settlerV2, "finalize", [id])).toBe("AlreadyFinalized");
  }

  test("T3 keeper path: a real call is scored from the tape; a wrong proposal is overturned by a dispute when a real touch happened", async () => {
    await lifecycle("keeper");
  }, 900_000);

  test("T4 CRE path: the real CRE workflow (cre workflow simulate --broadcast) proposes the settlement; score == independent recomputation", async () => {
    await lifecycle("cre");
  }, 900_000);
});
