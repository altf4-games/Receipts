/** Handler tests with simulated events (unit tests: mocks never count as proof; the live check compares with the chain). */
import { describe, expect, test } from "vitest";
import { createTestIndexer } from "envio";

const CUR = "0x909bad90d6ec72cb1ff9e37c8309b1c0b245f735";
// every simulated block must be at/after the contracts' configured start blocks (the newest is the PriceTape/SettlerV2 deploy block)
const B = 68_400_000;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ev = (contract: string, event: string, params: Record<string, unknown>, block = B, ts = 1_791_000_000): any => ({
  contract, event, params, block: { number: block, timestamp: ts },
});
const committed = (callId: number, perpId = 16, block = B + 10, ts = 1_791_000_000) =>
  ev("CallRegistry", "Committed", {
    callId: BigInt(callId), curator: CUR, perpId: BigInt(perpId), hash: HASH, horizonSecs: 3600, commitBlock: BigInt(block), commitTime: BigInt(ts),
    horizonEnd: BigInt(ts + 3600), entryPNS: 858_625n, entryOracleTs: BigInt(ts - 5), priceDecimals: 1,
  }, block, ts);
const registered = ev("CuratorRegistry", "Registered", { curator: CUR, handle: "pradyum", isBot: false, bond: 50_000_000n }, B);

describe("Receipts handlers", () => {
  test("commit -> reveal -> settle by SettlerV1 builds Call + CuratorStats + MarketStats", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: { 10143: { simulate: [
        registered,
        committed(19),
        ev("CallRegistry", "Revealed", { callId: 19n, direction: 1, tpBps: 200, slBps: 100, valid: true }, B + 20, 1_791_001_800),
        ev("CallRegistry", "Closed", { callId: 19n, scoreBps: 45, flags: 1, settler: "0xF39358B88cF73a1d9158f00b9D5E39A04543E03f" }, B + 100, 1_791_003_700),
        ev("SettlerV1", "Settled", { callId: 19n, entryPNS: 858_625n, exitPNS: 862_500n, exitOracleTs: 1_791_003_650n, rawBps: 45n, scoreBps: 45, flags: 1 }, B + 100, 1_791_003_700),
      ] } },
    });
    const call = await indexer.Call.getOrThrow("19");
    expect(call).toMatchObject({ status: "SETTLED", scoreBps: 45, direction: 1, tpBps: 200, slBps: 100, pathScored: false, disputed: false, exitPNS: 862_500n, curator_id: CUR, perpId: 16 });
    const stats = await indexer.CuratorStats.getOrThrow(CUR);
    expect(stats).toMatchObject({ calls: 1, settled: 1, wins: 1, sumScoreBps: 45, equityBps: 45, maxDrawdownBps: 0 });
    const m = await indexer.MarketStats.getOrThrow("16");
    expect(m).toMatchObject({ calls: 1, longs: 1, settled: 1, wins: 1, sumScoreBps: 45 });
    expect(await indexer.OpenSlot.getWhere({ chainId: { _eq: 10143 } })).toHaveLength(0); // slot freed
  });

  test("an unrevealed call expires at -3000 bps and frees the slot", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate: [registered, committed(20), ev("CallRegistry", "Expired", { callId: 20n }, B + 200, 1_791_010_000)] } } });
    expect(await indexer.Call.getOrThrow("20")).toMatchObject({ status: "EXPIRED", scoreBps: -3000 });
    expect(await indexer.CuratorStats.getOrThrow(CUR)).toMatchObject({ expired: 1, losses: 1, equityBps: -3000, maxDrawdownBps: 3000 });
  });

  test("an invalid reveal scores the penalty at once", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate: [registered, committed(21), ev("CallRegistry", "Revealed", { callId: 21n, direction: 1, tpBps: 9999, slBps: 100, valid: false }, B + 30)] } } });
    expect(await indexer.Call.getOrThrow("21")).toMatchObject({ status: "INVALID", scoreBps: -3000 });
    expect(await indexer.CuratorStats.getOrThrow(CUR)).toMatchObject({ invalid: 1 });
  });

  test("a SettlerV2 settlement with a dispute is flagged path-scored and disputed", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: { 10143: { simulate: [
        registered, committed(22),
        ev("CallRegistry", "Revealed", { callId: 22n, direction: 2, tpBps: 100, slBps: 100, valid: true }, B + 20),
        ev("SettlerV2", "Proposed", { callId: 22n, index: 5, touch: false, scoreBps: 3, by: "0x4400D7ca5f75C2ea4D4e99C4A5cb07Fe7e5e851C" }, B + 50),
        ev("SettlerV2", "Disputed", { callId: 22n, oldIndex: 5, newIndex: 2, scoreBps: 100, by: CUR }, B + 51),
        ev("SettlerV2", "Finalized", { callId: 22n, scoreBps: 100, flags: 12 }, B + 60),
        ev("CallRegistry", "Closed", { callId: 22n, scoreBps: 100, flags: 12, settler: "0xBdCF5A34a13617f62FFB9d3155dF3fA2939e73Dc" }, B + 60),
      ] } },
    });
    expect(await indexer.SettlementProposal.getOrThrow("22")).toMatchObject({ index: 2, touch: true, scoreBps: 100, disputed: true, finalized: true });
    expect(await indexer.Call.getOrThrow("22")).toMatchObject({ pathScored: true, disputed: true, scoreBps: 100 });
  });

  test("subscriptions roll up into CuratorRevenue", async () => {
    const indexer = createTestIndexer();
    const sub = "0xdA311C0354eE69872B5339b4C054BBEF9dF8ec00";
    await indexer.process({
      chains: { 10143: { simulate: [
        registered,
        ev("Subscriptions", "RateSet", { curator: CUR, ratePerSec: 1389n }),
        ev("Subscriptions", "Subscribed", { subscriber: sub, curator: CUR, payer: sub, amount: 5_000_000n, rate: 1389n, start: 1000n, activeUntil: 4600n }),
        ev("Subscriptions", "Subscribed", { subscriber: sub, curator: CUR, payer: sub, amount: 1_000_000n, rate: 1389n, start: 1000n, activeUntil: 5300n }),
        ev("Subscriptions", "Cancelled", { subscriber: sub, curator: CUR, refunded: 2_000_000n, paidToCurator: 4_000_000n }),
        ev("Subscriptions", "Claimed", { curator: CUR, amount: 4_000_000n }),
      ] } },
    });
    expect(await indexer.CuratorRevenue.getOrThrow(CUR)).toMatchObject({ rate: 1389n, subscribers: 1, totalDeposited: 6_000_000n, totalRefunded: 2_000_000n, claimed: 4_000_000n });
    expect(await indexer.Subscription.getOrThrow(`${CUR}-${sub.toLowerCase()}`)).toMatchObject({ payments: 2, totalDeposited: 6_000_000n, totalPaidOnCancel: 4_000_000n });
  });

  test("price tape samples update MarketStats and CrossCheck events are stored", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: { 10143: { simulate: [
        ev("PriceTape", "Sampled", { perpId: 16n, index: 0n, oracleTs: 1_791_000_000n, price: 858_625n, writer: "0xEf77a024c296C6539436f699Aa16140047580D8e" }),
        ev("PriceTape", "CrossCheck", { perpId: 16n, oraclePrice: 858_625n, restPrice: 858_900n, divergenceBps: 3n }),
      ] } },
    });
    expect(await indexer.TapeSample.getOrThrow("16-0")).toMatchObject({ price: 858_625n, index: 0 });
    expect(await indexer.MarketStats.getOrThrow("16")).toMatchObject({ tapeSamples: 1, lastOraclePrice: 858_625n });
    const cc = await indexer.CrossCheck.getWhere({ chainId: { _eq: 10143 } });
    expect(cc).toHaveLength(1);
    expect(cc[0]).toMatchObject({ divergenceBps: 3, restPrice: 858_900n });
  });
});

describe("Rankers and settler rotation", () => {
  test("a registered ranker keeps its git commit; publishing a ranking updates it", async () => {
    const indexer = createTestIndexer();
    const commit = "0x0123456789abcdef0123456789abcdef01234567";
    await indexer.process({
      chains: { 10143: { simulate: [
        ev("RankerRegistry", "RankerRegistered", { rankerId: 1n, author: CUR, name: "luck-adjusted", codeURI: "https://example.com/c", gitCommit: commit }, B + 5),
        ev("RankerRegistry", "RankingPublished", { rankerId: 1n, merkleRoot: HASH, asOfBlock: BigInt(B + 4), by: CUR }, B + 6),
      ] } },
    });
    expect(await indexer.Ranker.getOrThrow("1")).toMatchObject({ name: "luck-adjusted", gitCommit: commit, lastPublishedRoot: HASH, lastPublishedAsOfBlock: B + 4, author: CUR });
  });

  test("the settler rotation is recorded", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate: [ev("CallRegistry", "SettlerChanged", { oldSettler: "0xF39358B88cF73a1d9158f00b9D5E39A04543E03f", newSettler: "0xBdCF5A34a13617f62FFB9d3155dF3fA2939e73Dc" }, B + 9)] } } });
    const rows = await indexer.SettlerChange.getWhere({ chainId: { _eq: 10143 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldSettler: "0xf39358b88cf73a1d9158f00b9d5e39a04543e03f", newSettler: "0xbdcf5a34a13617f62ffb9d3155df3fa2939e73dc" });
  });
});

describe("Perpl analytics (multichain)", () => {
  const ACCT = 777n;
  const opened = (block: number, positionType: number, lot: bigint, price: bigint, ts = 1_791_000_000) =>
    ev("PerplTrades", "PositionOpenedV2", {
      perpId: 16n, accountId: ACCT, positionType, leverageHdths: 1000n, depositCNS: 1n, pnlCollateralizedCNS: 0n, pricePNS: price, lotLNS: lot,
      insFeeCNS: 0n, protFeeCNS: 0n, priceResiduePNSQ16: 0n,
    }, block, ts);

  test("a curator's Perpl position opened while their call is open is recorded as skin in the game", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: { 10143: { simulate: [
        ev("PerplAccounts", "AccountCreated", { account: CUR, id: ACCT }, B - 100),
        registered, // registered AFTER the Perpl account: the link is made at registration
        committed(30, 16, B + 10),
        opened(B + 20, 0, 50_000n, 860_000n), // long 0.5 BTC, 10 blocks after the commit
        opened(B + 21, 1, 20_000n, 860_100n), // short 0.2 BTC
      ] } },
    });
    expect((await indexer.Curator.getOrThrow(CUR)).perplAccountId).toBe(ACCT);
    expect(await indexer.Call.getOrThrow("30")).toMatchObject({ perplTrades: 2, perplLongLots: 50_000n, perplShortLots: 20_000n });
    const trades = await indexer.PerplCuratorTrade.getWhere({ chainId: { _eq: 10143 } });
    expect(trades.map((t) => [t.positionType, t.blocksSinceCommit]).sort()).toEqual([[0, 10], [1, 11]]);
  });

  test("positions of non-curators only feed the daily market analytics; mainnet is indexed as its own chain", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: { simulate: [opened(B + 200, 0, 100_000n, 860_000n)] },
        143: { simulate: [{ ...opened(110_800_000, 1, 2_000n, 120_500n), params: { perpId: 31n, accountId: 5n, positionType: 1, leverageHdths: 1000n, depositCNS: 1n, pnlCollateralizedCNS: 0n, pricePNS: 120_500n, lotLNS: 2_000n, insFeeCNS: 0n, protFeeCNS: 0n, priceResiduePNSQ16: 0n } }] },
      },
    });
    const testnet = await indexer.PerplMarketDay.getWhere({ chainId: { _eq: 10143 } });
    expect(testnet).toHaveLength(1);
    expect(testnet[0]).toMatchObject({ perpId: 16, opens: 1, longOpens: 1, notionalMicroUsd: 86_000_000_000n });
    const mainnet = await indexer.PerplMarketDay.getWhere({ chainId: { _eq: 143 } });
    expect(mainnet[0]).toMatchObject({ perpId: 31, shortOpens: 1, notionalMicroUsd: 241_000_000n });
    expect(await indexer.PerplCuratorTrade.getWhere({ chainId: { _eq: 10143 } })).toHaveLength(0);
  });
});
