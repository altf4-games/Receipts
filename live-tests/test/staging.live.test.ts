/**
 * LIVE regression suite against the STAGING deployment on Monad testnet (chain 10143).
 * Real transactions, real Perpl oracle, real AUSD. No mocks. Every tx hash is logged and written to docs/live-runs/.
 * Rerunnable: beforeAll resolves any call a previous (crashed) run left open.
 *
 * Covers plan.md L1-L6 (+L7/L9 guards) and attacks A1, A2, A3, A5, A20-ish on live state.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import {
  AUSD, EXCHANGE, FAUCET, abis, deployment, erc20Abi, faucetAbi, publicClient, rawOracleAt, record, send,
  simulateRevert, sleep, wallet, waitUntilTimestamp, chainNow, type Sent,
} from "../src/chain.js";

const CR = deployment.callRegistry;
const CU = deployment.curatorRegistry;
const ST = deployment.settlerV1;
const BTC = 16n, ETH = 32n, SOL = 48n;
const LONG = 1, SHORT = 2;
const STATUS = ["None", "Sealed", "Revealed", "Settled", "Expired", "Invalid"] as const;
const FLAG_APPROX = 1, FLAG_LATE = 2;

const A = wallet("TESTER_CURATOR"); //  live-curator-a
const B = wallet("TESTER_SUBSCRIBER"); // live-curator-b (second curator)
const OWNER = wallet("DEPLOYER"); //  registry owner (deployer EOA)
const KEEPER = wallet("KEEPER"); //  an unrelated third party; also never registered

type Call = {
  curator: Address; perpId: number; status: number; priceDecimals: number; direction: number; tpBps: number; slBps: number;
  flags: number; scoreBps: number; horizonSecs: number; commitBlock: bigint; commitTime: bigint; horizonEnd: bigint;
  entryOracleTs: bigint; revealBlock: bigint; closeBlock: bigint; entryPNS: bigint; hash: Hex;
};
const getCall = async (id: bigint) => (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "getCall", args: [id] })) as unknown as Call;
const openCallId = async (who: Address, perp: bigint) => (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [who, perp] })) as bigint;
const rnd = () => keccak256(toHex(crypto.randomUUID())) as Hex;

/** keccak256(abi.encode(chainid, registry, curator, perpId, direction, tp, sl, horizon, salt)) computed OFF-chain. */
function localHash(curator: Address, perp: bigint, dir: number, tp: number, sl: number, horizon: number, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [10143n, CR, curator, perp, dir, tp, sl, horizon, salt],
    ),
  );
}

async function commit(w: typeof A, perp: bigint, dir: number, tp: number, sl: number, horizon: number) {
  const salt = rnd();
  const hash = localHash(w.account.address, perp, dir, tp, sl, horizon, salt);
  const sent = await send(w, CR, abis.call, "commit", [perp, hash, horizon]);
  expect(sent.receipt.status).toBe("success");
  const id = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "openCallId", args: [w.account.address, perp] })) as bigint;
  return { id, salt, hash, sent, dir, tp, sl, horizon };
}
type Committed = Awaited<ReturnType<typeof commit>>;

const gasLog: Record<string, { estimate?: string; limit: string; used: string }> = {};
const noteGas = (name: string, s: Sent) => {
  gasLog[name] = { estimate: s.gasEstimate?.toString(), limit: s.gasLimit.toString(), used: s.receipt.gasUsed.toString() };
};

async function ensureCurator(w: typeof A, handle: string) {
  const c = (await publicClient.readContract({ address: CU, abi: abis.curators, functionName: "getCurator", args: [w.account.address] })) as { registered: boolean };
  if (c.registered) return;
  const bal = (await publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [w.account.address] })) as bigint;
  if (bal < BigInt(deployment.minBond)) {
    for (let attempt = 0; ; attempt++) {
      try {
        const f = await send(w, FAUCET, faucetAbi, "requestFunds", [w.account.address]);
        record("faucet.requestFunds", { who: handle, tx: f.hash, status: f.receipt.status });
        if (f.receipt.status === "success") break;
      } catch (e) {
        if (attempt > 4) throw e;
      }
      await sleep(62_000); // faucet is rate limited to 1 call / 60 s
    }
  }
  const ap = await send(w, AUSD, erc20Abi, "approve", [CU, 2n ** 256n - 1n]);
  record("ausd.approve", { who: handle, tx: ap.hash });
  const reg = await send(w, CU, abis.curators, "register", [handle, "", false, BigInt(deployment.minBond)]);
  expect(reg.receipt.status).toBe("success");
  record("curators.register", { who: handle, tx: reg.hash });
}

/** Resolve anything a previous run left open so this run starts clean. */
async function ensureClean(w: typeof A) {
  for (const perp of [16n, 32n, 48n, 64n, 256n]) {
    const id = await openCallId(w.account.address, perp);
    if (id === 0n) continue;
    const c = await getCall(id);
    await waitUntilTimestamp(c.horizonEnd, true);
    if (STATUS[c.status] === "Sealed") {
      const s = await send(KEEPER, CR, abis.call, "expire", [id]);
      record("cleanup.expire", { id, tx: s.hash });
    } else if (STATUS[c.status] === "Revealed") {
      for (let i = 0; i < 60; i++) {
        const o = await rawOracleAt(perp);
        if (o.ts >= c.horizonEnd) break;
        await sleep(2000);
      }
      const s = await send(KEEPER, ST, abis.settler, "settle", [id]);
      record("cleanup.settle", { id, tx: s.hash });
    }
  }
}


/** Staging must always return to SettlerV1 as the active settler (a crashed A14 run could leave it elsewhere). */
async function ensureSettlerIsV1() {
  const cur = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "settler" })) as Address;
  if (cur.toLowerCase() === ST.toLowerCase()) return;
  const pend = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "pendingSettler" })) as Address;
  if (pend.toLowerCase() !== ST.toLowerCase()) {
    const p = await send(OWNER, CR, abis.call, "proposeSettler", [ST]);
    record("heal.proposeSettlerV1", { tx: p.hash });
  }
  const eta = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "pendingSettlerEta" })) as bigint;
  await waitUntilTimestamp(eta);
  const a = await send(KEEPER, CR, abis.call, "activateSettler", []);
  record("heal.activateSettlerV1", { tx: a.hash });
}

const S: { btc?: Committed; eth?: Committed; sol?: Committed; solSalt?: Hex; keeperFeeCheck?: unknown } = {};

describe.sequential("STAGING live: Receipts core on Monad testnet", () => {
  beforeAll(async () => {
    record("run.start", { callRegistry: CR, curatorRegistry: CU, settler: ST, exchange: EXCHANGE, block: await publicClient.getBlockNumber() });
    for (const w of [A, B, KEEPER]) {
      const bal = await publicClient.getBalance({ address: w.account.address });
      expect(bal, `${w.account.address} needs MON`).toBeGreaterThan(2n * 10n ** 17n);
    }
    await ensureSettlerIsV1();
    await ensureCurator(A, "live-curator-a");
    await ensureCurator(B, "live-curator-b");
    await ensureClean(A);
    await ensureClean(B);
  });

  test("L1 commit snapshots the real oracle; off-chain hash == on-chain hashCall; entry matches independent historical reads (A1)", async () => {
    const c = await commit(A, BTC, LONG, 500, 300, 120);
    S.btc = c;
    noteGas("commit", c.sent);
    const onchainHash = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "hashCall", args: [A.account.address, BTC, LONG, 500, 300, 120, c.salt] })) as Hex;
    expect(c.hash).toBe(onchainHash);

    const call = await getCall(c.id);
    expect(STATUS[call.status]).toBe("Sealed");
    expect(call.commitBlock).toBe(c.sent.receipt.blockNumber);
    expect(call.hash).toBe(c.hash);

    // The oracle can tick in the same block after our tx, so the snapshot equals the oracle at B-1 or at B.
    const b = c.sent.receipt.blockNumber;
    const [before, at] = await Promise.all([rawOracleAt(BTC, b - 1n), rawOracleAt(BTC, b)]);
    const matched = call.entryPNS === before.price && call.entryOracleTs === before.ts ? "B-1" : call.entryPNS === at.price && call.entryOracleTs === at.ts ? "B" : "NONE";
    record("L1.commit", { id: c.id, tx: c.sent.hash, block: b, entryPNS: call.entryPNS, entryOracleTs: call.entryOracleTs, decimals: call.priceDecimals, oracleAtBminus1: before.price, oracleAtB: at.price, matched });
    expect(matched, "stored entry must equal the real oracle at the commit block (B-1 or B)").not.toBe("NONE");
    expect(call.priceDecimals).toBe(before.decimals);
  });

  test("setup: commit ETH (will expire unrevealed) and SOL (invalid params) on the same timeline", async () => {
    S.eth = await commit(A, ETH, LONG, 500, 300, 60);
    noteGas("commit(eth)", S.eth.sent);
    // SOL: hash binds tp=0 (out of bounds). The hash matches, so reveal must classify it Invalid, not revert.
    S.sol = await commit(A, SOL, SHORT, 0, 300, 60);
    record("setup.commits", { eth: S.eth.id, ethTx: S.eth.sent.hash, sol: S.sol.id, solTx: S.sol.sent.hash });
  });

  test("L2 second open call on the same market reverts, as a real mined revert (A2)", async () => {
    const salt = rnd();
    const h = localHash(A.account.address, BTC, SHORT, 500, 300, 120, salt);
    expect(await simulateRevert(A, CR, abis.call, "commit", [BTC, h, 120])).toBe("OpenCallExists");
    const hash = await A.client.writeContract({ address: CR, abi: abis.call, functionName: "commit", args: [BTC, h, 120], gas: 300_000n } as never);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    record("L2.revert", { tx: hash, status: r.status, block: r.blockNumber });
    expect(r.status).toBe("reverted");
    expect(await openCallId(A.account.address, BTC)).toBe(S.btc!.id); // untouched
  });

  test("L7 a wallet that never registered cannot commit", async () => {
    const h = localHash(KEEPER.account.address, BTC, LONG, 500, 300, 120, rnd());
    expect(await simulateRevert(KEEPER, CR, abis.call, "commit", [BTC, h, 120])).toBe("NotBonded");
  });

  test("L9 only the settler can close()", async () => {
    expect(await simulateRevert(A, CR, abis.call, "close", [S.btc!.id, 0, 0])).toBe("NotSettler");
  });

  test("L3 wrong salt reveal reverts (real tx); the right reveal by a THIRD PARTY passes; measure Monad gas-on-limit", async () => {
    const c = S.btc!;
    expect(await simulateRevert(KEEPER, CR, abis.call, "reveal", [c.id, c.dir, c.tp, c.sl, rnd()])).toBe("BadReveal");
    const bad = await KEEPER.client.writeContract({ address: CR, abi: abis.call, functionName: "reveal", args: [c.id, c.dir, c.tp, c.sl, rnd()], gas: 200_000n } as never);
    const badR = await publicClient.waitForTransactionReceipt({ hash: bad });
    record("L3.badSalt", { tx: bad, status: badR.status });
    expect(badR.status).toBe("reverted");

    const b0 = await publicClient.getBalance({ address: KEEPER.account.address });
    const ok = await send(KEEPER, CR, abis.call, "reveal", [c.id, c.dir, c.tp, c.sl, c.salt]);
    noteGas("reveal", ok);
    expect(ok.receipt.status).toBe("success");
    const b1 = await publicClient.getBalance({ address: KEEPER.account.address });
    const paid = b0 - b1;
    const price = ok.receipt.effectiveGasPrice;
    S.keeperFeeCheck = {
      paidWei: paid, gasUsed: ok.receipt.gasUsed, gasLimit: ok.gasLimit, effectiveGasPrice: price,
      equalsGasUsedTimesPrice: paid === ok.receipt.gasUsed * price, equalsGasLimitTimesPrice: paid === ok.gasLimit * price,
    };
    record("L3.reveal.thirdParty.gasOnLimit", { tx: ok.hash, ...(S.keeperFeeCheck as object) });
    const call = await getCall(c.id);
    expect(STATUS[call.status]).toBe("Revealed");
    expect(call.direction).toBe(LONG);
    expect(await openCallId(A.account.address, BTC)).toBe(c.id); // slot stays occupied until scored
  });

  test("L5 hash matches but params invalid => Invalid, penalty score, slot freed (A5)", async () => {
    const c = S.sol!;
    const s = await send(KEEPER, CR, abis.call, "reveal", [c.id, c.dir, c.tp, c.sl, c.salt]);
    noteGas("reveal(invalid)", s);
    expect(s.receipt.status).toBe("success");
    const call = await getCall(c.id);
    record("L5.invalid", { id: c.id, tx: s.hash, status: STATUS[call.status], score: call.scoreBps });
    expect(STATUS[call.status]).toBe("Invalid");
    expect(call.scoreBps).toBe(-3000);
    expect(await openCallId(A.account.address, SOL)).toBe(0n);
  });

  test("L6a settle before the horizon reverts (TooEarly)", async () => {
    const call = await getCall(S.btc!.id);
    expect(await chainNow(), "test too slow: BTC horizon already passed").toBeLessThan(call.horizonEnd);
    expect(await simulateRevert(KEEPER, ST, abis.settler, "settle", [S.btc!.id])).toBe("TooEarly");
  });

  test("L4 never-revealed call: expire reverts inside the window, then scores the -30% penalty and frees the slot (A3)", async () => {
    const c = S.eth!;
    const call = await getCall(c.id);
    if ((await chainNow()) <= call.horizonEnd) {
      expect(await simulateRevert(KEEPER, CR, abis.call, "expire", [c.id])).toBe("NotYetExpired");
    }
    await waitUntilTimestamp(call.horizonEnd, true); // strictly after
    const s = await send(KEEPER, CR, abis.call, "expire", [c.id]);
    noteGas("expire", s);
    expect(s.receipt.status).toBe("success");
    const after = await getCall(c.id);
    record("L4.expire", { id: c.id, tx: s.hash, status: STATUS[after.status], score: after.scoreBps });
    expect(STATUS[after.status]).toBe("Expired");
    expect(after.scoreBps).toBe(-3000);
    expect(await openCallId(A.account.address, ETH)).toBe(0n);
    // A revealed-after-expiry attempt must fail
    expect(await simulateRevert(KEEPER, CR, abis.call, "reveal", [c.id, c.dir, c.tp, c.sl, c.salt])).toBe("WrongStatus");
  });

  test("L6b settle after the horizon: score equals an independent recompute from historical oracle reads", async () => {
    const c = S.btc!;
    const pre = await getCall(c.id);
    await waitUntilTimestamp(pre.horizonEnd);
    // wait for an oracle sample stamped at/after the horizon (updates every ~50 s)
    let sampleTs = 0n;
    for (let i = 0; i < 90; i++) {
      sampleTs = (await rawOracleAt(BTC)).ts;
      if (sampleTs >= pre.horizonEnd) break;
      await sleep(2000);
    }
    expect(sampleTs, "no oracle sample at/after horizon within 3 min").toBeGreaterThanOrEqual(pre.horizonEnd);

    const s = await send(KEEPER, ST, abis.settler, "settle", [c.id]);
    noteGas("settle", s);
    expect(s.receipt.status).toBe("success");
    const call = await getCall(c.id);
    expect(STATUS[call.status]).toBe("Settled");

    const b = s.receipt.blockNumber;
    const [x1, x2] = await Promise.all([rawOracleAt(BTC, b - 1n), rawOracleAt(BTC, b)]);
    const score = (exit: bigint) => {
      const raw = ((exit - pre.entryPNS) * 10_000n) / pre.entryPNS; // BigInt division truncates toward zero, like Solidity
      return raw < -300n ? -300n : raw > 500n ? 500n : raw;
    };
    const candidates = [score(x1.price), score(x2.price)];
    record("L6.settle", {
      id: c.id, tx: s.hash, block: b, entryPNS: pre.entryPNS, exitAtBminus1: x1.price, exitAtB: x2.price,
      exitTsAtB: x2.ts, horizonEnd: pre.horizonEnd, scoreOnchain: call.scoreBps, recomputed: candidates, flags: call.flags,
    });
    expect(candidates.map(Number)).toContain(call.scoreBps);
    expect(call.flags & FLAG_APPROX).toBe(FLAG_APPROX);
    expect(await openCallId(A.account.address, BTC)).toBe(0n);
    // settling twice must fail
    expect(await simulateRevert(KEEPER, ST, abis.settler, "settle", [c.id])).toBe("NotRevealed");
    expect(call.flags & ~(FLAG_APPROX | FLAG_LATE)).toBe(0);
  });


  test("A14 settler rotation is TIMELOCKED live: propose -> early activate reverts -> old settler still rules -> activate -> old settler powerless -> rotate back", async () => {
    const delay = BigInt(deployment.settlerDelay);
    const other = KEEPER.account.address; // any address; staging only
    const settlerNow = async () => (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "settler" })) as Address;
    expect(await settlerNow()).toBe(ST);

    // non-owner cannot propose
    expect(await simulateRevert(KEEPER, CR, abis.call, "proposeSettler", [other])).toMatch(/OwnableUnauthorizedAccount|revert/);

    const p = await send(OWNER, CR, abis.call, "proposeSettler", [other]);
    expect(p.receipt.status).toBe("success");
    const eta = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "pendingSettlerEta" })) as bigint;
    record("A14.propose", { tx: p.hash, pending: other, eta, delay });
    expect(eta - (await publicClient.getBlock({ blockNumber: p.receipt.blockNumber })).timestamp).toBe(delay);

    expect(await simulateRevert(KEEPER, CR, abis.call, "activateSettler", [])).toBe("SettlerDelayActive");
    expect(await settlerNow()).toBe(ST); // nothing moved

    await waitUntilTimestamp(eta);
    const act = await send(KEEPER, CR, abis.call, "activateSettler", []); // anyone
    expect(act.receipt.status).toBe("success");
    expect(await settlerNow()).toBe(other);
    record("A14.activate", { tx: act.hash, newSettler: other });

    // power moved: a non-settler is refused at the auth gate, while the NEW settler (KEEPER here) passes it
    // and is only stopped later because the call is already Settled
    expect(await simulateRevert(OWNER, CR, abis.call, "close", [S.btc!.id, 0, 0])).toBe("NotSettler");
    expect(await simulateRevert(KEEPER, CR, abis.call, "close", [S.btc!.id, 0, 0])).toBe("WrongStatus");

    // rotate back so the rest of staging keeps working
    const back = await send(OWNER, CR, abis.call, "proposeSettler", [ST]);
    const eta2 = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "pendingSettlerEta" })) as bigint;
    await waitUntilTimestamp(eta2);
    const act2 = await send(KEEPER, CR, abis.call, "activateSettler", []);
    expect(act2.receipt.status).toBe("success");
    expect(await settlerNow()).toBe(ST);
    record("A14.rotateBack", { proposeTx: back.hash, activateTx: act2.hash });
  });

  test("owner transfer is two-step (propose does not move ownership) -- read-only check", async () => {
    const owner = (await publicClient.readContract({ address: CR, abi: abis.call, functionName: "owner" })) as Address;
    expect(owner.toLowerCase()).toBe(OWNER.account.address.toLowerCase());
    // a stranger cannot accept ownership that was never offered
    expect(await simulateRevert(KEEPER, CR, abis.call, "acceptOwnership", [])).toMatch(/OwnableUnauthorizedAccount|revert/);
  });

  test("gas report (Monad charges the gas LIMIT, not gas used)", () => {
    record("gas.report", { gasLog, keeperFeeCheck: S.keeperFeeCheck });
    const k = S.keeperFeeCheck as { equalsGasLimitTimesPrice: boolean; equalsGasUsedTimesPrice: boolean };
    expect(k.equalsGasLimitTimesPrice || k.equalsGasUsedTimesPrice).toBe(true);
  });
});
