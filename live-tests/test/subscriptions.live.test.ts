/**
 * LIVE suite for Subscriptions (plan L7) against the STAGING deployment on Monad testnet. Real txs, real AUSD.
 * Every figure is compared with an independent recomputation from the stream's start and the block timestamps.
 * Run alone (shares wallets with the other live suites): pnpm exec vitest run test/subscriptions.live.test.ts
 */
import { beforeAll, describe, expect, test } from "vitest";
import type { Address } from "viem";
import {
  AUSD, FAUCET, abis, deployment, erc20Abi, faucetAbi, publicClient, record, send, simulateRevert, sleep, wallet, waitUntilTimestamp,
} from "../src/chain.js";

const SUBS = deployment.subscriptions as Address;
const CU = deployment.curatorRegistry;
const CURATOR = wallet("TESTER_CURATOR"); // registered on staging by the contracts suite
const SUBSCRIBER = wallet("TESTER_SUBSCRIBER");
const BENEFICIARY = wallet("DEPLOYER");
const STRANGER = wallet("KEEPER"); // never a registered curator
const RATE = 10_000n; // 0.01 AUSD / s

type Stream = { deposit: bigint; claimed: bigint; rate: bigint; start: bigint };
const bal = async (a: Address, blockNumber?: bigint) =>
  (await publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [a], blockNumber })) as bigint;
const stream = async (blockNumber?: bigint) =>
  (await publicClient.readContract({ address: SUBS, abi: abis.subscriptions, functionName: "getStream", args: [CURATOR.account.address, SUBSCRIBER.account.address], blockNumber })) as Stream;
const rd = async (fn: string, args: unknown[], blockNumber?: bigint) =>
  publicClient.readContract({ address: SUBS, abi: abis.subscriptions, functionName: fn, args, blockNumber } as never);
const tsOf = async (r: { blockNumber: bigint }) => (await publicClient.getBlock({ blockNumber: r.blockNumber })).timestamp;

async function ensureFunds(w: typeof CURATOR, need: bigint, name: string) {
  for (let i = 0; (await bal(w.account.address)) < need; i++) {
    try {
      const f = await send(w, FAUCET, faucetAbi, "requestFunds", [w.account.address]);
      record("faucet.requestFunds", { who: name, tx: f.hash, status: f.receipt.status });
    } catch (e) {
      if (i > 4) throw e;
    }
    await sleep(62_000);
  }
}

async function cleanup() {
  // leave no stream behind from a crashed run
  const s = await stream();
  if (s.deposit !== 0n) await send(SUBSCRIBER, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address]);
  const d = (await publicClient.readContract({ address: SUBS, abi: abis.subscriptions, functionName: "getStream", args: [CURATOR.account.address, BENEFICIARY.account.address] })) as Stream;
  if (d.deposit !== 0n) await send(BENEFICIARY, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address]);
}

describe("Subscriptions live (staging)", () => {
  beforeAll(async () => {
    expect(SUBS, "staging.json has no subscriptions address").toBeTruthy();
    const c = (await publicClient.readContract({ address: CU, abi: abis.curators, functionName: "getCurator", args: [CURATOR.account.address] })) as { registered: boolean };
    expect(c.registered, "run the contracts live suite first: TESTER_CURATOR must be a registered curator").toBe(true);
    await ensureFunds(SUBSCRIBER, 5_000_000n, "subscriber");
    await cleanup();
    const approve = await send(SUBSCRIBER, AUSD, erc20Abi, "approve", [SUBS, 2n ** 256n - 1n]);
    expect(approve.receipt.status).toBe("success");
    const a = await send(BENEFICIARY, AUSD, erc20Abi, "approve", [SUBS, 0n]); // beneficiary only receives
    expect(a.receipt.status).toBe("success");
    // claim anything left from an earlier run so balances start clean
    await send(CURATOR, SUBS, abis.subscriptions, "claim", [[]]);
  }, 600_000);

  test("L7a: guards (unregistered curator, below one second, not accepting)", async () => {
    expect(await simulateRevert(SUBSCRIBER, SUBS, abis.subscriptions, "subscribe", [STRANGER.account.address, 1_000_000n])).toBe("NotBondedCurator");
    const set = await send(CURATOR, SUBS, abis.subscriptions, "setRate", [RATE]);
    expect(set.receipt.status).toBe("success");
    expect(await rd("ratePerSec", [CURATOR.account.address])).toBe(RATE);
    expect(await simulateRevert(SUBSCRIBER, SUBS, abis.subscriptions, "subscribe", [CURATOR.account.address, RATE - 1n])).toBe("AmountTooSmall");
    expect(await simulateRevert(STRANGER, SUBS, abis.subscriptions, "setRate", [1n])).toBe("NotBondedCurator");
  }, 120_000);

  test("L7b: isActive transitions, accrual and exact refund match an independent recompute", async () => {
    const deposit = RATE * 90n; // 90 s
    const before = await bal(SUBSCRIBER.account.address);
    expect(await rd("isActive", [SUBSCRIBER.account.address, CURATOR.account.address])).toBe(false);
    const sub = await send(SUBSCRIBER, SUBS, abis.subscriptions, "subscribe", [CURATOR.account.address, deposit]);
    expect(sub.receipt.status).toBe("success");
    const s = await stream(sub.receipt.blockNumber);
    expect(s.deposit).toBe(deposit);
    expect(s.rate).toBe(RATE);
    expect(s.start).toBe(await tsOf(sub.receipt));
    expect(await bal(SUBSCRIBER.account.address)).toBe(before - deposit);
    expect(await rd("isActive", [SUBSCRIBER.account.address, CURATOR.account.address])).toBe(true);
    expect(await rd("activeUntil", [SUBSCRIBER.account.address, CURATOR.account.address])).toBe(s.start + 90n);
    record("subs.subscribe", { tx: sub.hash, deposit, start: s.start });

    await waitUntilTimestamp(s.start + 30n);
    // accrued at a specific block == rate * (blockTs - start)
    const blk = await publicClient.getBlock();
    const acc = (await rd("accrued", [SUBSCRIBER.account.address, CURATOR.account.address], blk.number)) as bigint;
    expect(acc).toBe(RATE * (blk.timestamp - s.start));

    const refundBefore = await bal(SUBSCRIBER.account.address);
    const cancel = await send(SUBSCRIBER, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address]);
    expect(cancel.receipt.status).toBe("success");
    const cts = await tsOf(cancel.receipt);
    const earned = RATE * (cts - s.start);
    expect(earned).toBeLessThan(deposit);
    expect((await bal(SUBSCRIBER.account.address)) - refundBefore).toBe(deposit - earned); // exact refund
    expect(await rd("owed", [CURATOR.account.address])).toBe(earned);
    expect(await rd("isActive", [SUBSCRIBER.account.address, CURATOR.account.address])).toBe(false);
    record("subs.cancel", { tx: cancel.hash, refunded: deposit - earned, paidToCurator: earned });

    const cBefore = await bal(CURATOR.account.address);
    const claim = await send(CURATOR, SUBS, abis.subscriptions, "claim", [[]]);
    expect(claim.receipt.status).toBe("success");
    expect((await bal(CURATOR.account.address)) - cBefore).toBe(earned);
    record("subs.claim", { tx: claim.hash, amount: earned });
  }, 300_000);

  test("L7c: expiry flips isActive, claim pays the full deposit, cancel afterwards refunds 0", async () => {
    const deposit = RATE * 20n;
    const sub = await send(SUBSCRIBER, SUBS, abis.subscriptions, "subscribe", [CURATOR.account.address, deposit]);
    const s = await stream(sub.receipt.blockNumber);
    const until = s.start + 20n;
    expect(await rd("activeUntil", [SUBSCRIBER.account.address, CURATOR.account.address])).toBe(until);
    await waitUntilTimestamp(until);
    const blk = await publicClient.getBlock();
    expect(await rd("isActive", [SUBSCRIBER.account.address, CURATOR.account.address], blk.number)).toBe(false);

    const cBefore = await bal(CURATOR.account.address);
    const claim = await send(CURATOR, SUBS, abis.subscriptions, "claim", [[SUBSCRIBER.account.address]]);
    expect(claim.receipt.status).toBe("success");
    expect((await bal(CURATOR.account.address)) - cBefore).toBe(deposit);

    const sBefore = await bal(SUBSCRIBER.account.address);
    const cancel = await send(SUBSCRIBER, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address]);
    expect(cancel.receipt.status).toBe("success");
    expect(await bal(SUBSCRIBER.account.address)).toBe(sBefore); // nothing left to refund
    record("subs.expiry", { subscribeTx: sub.hash, claimTx: claim.hash, cancelTx: cancel.hash, deposit });
  }, 300_000);

  test("L7d: subscribeFor, payer pays and beneficiary owns, then top-up keeps the stream's rate", async () => {
    const deposit = RATE * 60n;
    const pBefore = await bal(SUBSCRIBER.account.address);
    const sub = await send(SUBSCRIBER, SUBS, abis.subscriptions, "subscribeFor", [BENEFICIARY.account.address, CURATOR.account.address, deposit]);
    expect(sub.receipt.status).toBe("success");
    expect(await bal(SUBSCRIBER.account.address)).toBe(pBefore - deposit);
    expect(await rd("isActive", [BENEFICIARY.account.address, CURATOR.account.address])).toBe(true);
    expect(await rd("isActive", [SUBSCRIBER.account.address, CURATOR.account.address])).toBe(false); // payer has no stream
    expect(await simulateRevert(SUBSCRIBER, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address])).toBe("NoStream");

    // curator raises the price: the running stream keeps its rate when topped up
    await send(CURATOR, SUBS, abis.subscriptions, "setRate", [RATE * 5n]);
    const top = await send(SUBSCRIBER, SUBS, abis.subscriptions, "subscribeFor", [BENEFICIARY.account.address, CURATOR.account.address, RATE * 10n]);
    expect(top.receipt.status).toBe("success");
    const st = (await publicClient.readContract({ address: SUBS, abi: abis.subscriptions, functionName: "getStream", args: [CURATOR.account.address, BENEFICIARY.account.address] })) as Stream;
    expect(st.rate).toBe(RATE);
    expect(st.deposit).toBe(RATE * 70n);

    const bBefore = await bal(BENEFICIARY.account.address);
    const cancel = await send(BENEFICIARY, SUBS, abis.subscriptions, "cancel", [CURATOR.account.address]);
    expect(cancel.receipt.status).toBe("success");
    const earned = RATE * ((await tsOf(cancel.receipt)) - st.start);
    expect((await bal(BENEFICIARY.account.address)) - bBefore).toBe(st.deposit - earned); // refund goes to the beneficiary
    await send(CURATOR, SUBS, abis.subscriptions, "claim", [[]]);
    await send(CURATOR, SUBS, abis.subscriptions, "setRate", [RATE]);
    record("subs.subscribeFor", { subscribeTx: sub.hash, topUpTx: top.hash, cancelTx: cancel.hash });
  }, 300_000);
});
