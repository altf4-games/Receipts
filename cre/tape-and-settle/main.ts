import {
  CronCapability, EVMClient, HTTPClient, LAST_FINALIZED_BLOCK_NUMBER, Runner, TxStatus, bytesToHex, consensusMedianAggregation,
  encodeCallMsg, getNetwork, handler, json, ok, prepareReportRequest, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex,
} from "viem";
import { z } from "zod";
import { REVEALED, pickProposal, planSampling, type CallInfo, type Oracle, type TapeHead, type TapeSample } from "./logic";

/**
 * Receipts: tape-and-settle (Chainlink CRE, TypeScript).
 *
 * Every run (cron, >= 30 s) the workflow
 *  1. reads the newest calls, the live Perpl oracle price (Exchange.getPerpetualInfo) and the PriceTape state, in a few
 *     Multicall3 EVM reads;
 *  2. calls Perpl's REST API (EXTERNAL API) for the last traded price of each market that needs a sample;
 *  3. writes a report to PriceTape (sample the oracle now + the REST price for a CrossCheck event) only when needed
 *     (tripwire / endpoint), because on Monad gas is charged on the gas limit and a continuous tape is unaffordable;
 *  4. for revealed calls past their horizon whose endpoint is on the tape, computes the first TP/SL touch and writes a
 *     proposal report to SettlerV2 (anyone can dispute it; the keeper finalizes).
 * `mode: "local-simulation"` does steps 1-2 and the decisions, logs what it WOULD write, and returns before any write.
 */
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const configSchema = z.object({
  schedule: z.string(),
  mode: z.enum(["local-simulation", "broadcast"]),
  chainSelectorName: z.string(),
  registry: addr,
  tape: addr,
  settlerV2: addr,
  exchange: addr,
  multicall3: addr,
  perplApi: z.string().regex(/^https:\/\/[A-Za-z0-9.-]+$/),
  markets: z.array(z.number().int().positive()).min(1).max(8),
  callWindow: z.number().int().min(1).max(40),
  // Monad charges the gas LIMIT, so size it from measured costs: tape.sample ~118k per market, forwarder overhead on top
  tapeGasBase: z.number().int().positive(),
  tapeGasPerMarket: z.number().int().positive(),
  settlerGasBase: z.number().int().positive(),
  settlerGasPerCall: z.number().int().positive(),
});
export type Config = z.infer<typeof configSchema>;

const mcAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const registryAbi = parseAbi([
  "function nextCallId() view returns (uint256)",
  "function getCall(uint256 callId) view returns ((address curator, uint32 perpId, uint8 status, uint8 priceDecimals, uint8 direction, uint16 tpBps, uint16 slBps, uint16 flags, int32 scoreBps, uint32 horizonSecs, uint64 commitBlock, uint64 commitTime, uint64 horizonEnd, uint64 entryOracleTs, uint64 revealBlock, uint64 closeBlock, uint128 entryPNS, bytes32 hash))",
]);
const tapeAbi = parseAbi([
  "function sampleCount(uint256 perpId) view returns (uint256)",
  "function sampleAt(uint256 perpId, uint256 index) view returns ((uint64 ts, uint64 blockNumber, uint128 price))",
  "function firstIndexAtOrAfter(uint256 perpId, uint64 ts) view returns (uint256)",
]);
const settlerAbi = parseAbi(["function proposals(uint256 callId) view returns (uint64 proposedAt, uint32 index, int32 scoreBps, bool touch, bool disputed, bool finalized)"]);
const GET_PERP_INFO = "0x00092cce"; // getPerpetualInfo(uint256): returns a dynamic struct; decoded from raw words below

type Call = { target: Address; data: Hex };
type Result = { success: boolean; data: Hex };

function evmClient(runtime: Runtime<Config>): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.chainSelectorName });
  if (!network) throw new Error(`Unknown chain selector name: ${runtime.config.chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
}

/** ONE EVM read capability call for many contract calls (EVM reads per execution are capped at 15). */
function multicall(runtime: Runtime<Config>, client: EVMClient, calls: Call[]): Result[] {
  if (calls.length === 0) return [];
  const reply = client
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.multicall3 as Address,
        data: encodeFunctionData({
          abi: mcAbi,
          functionName: "aggregate3",
          args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))],
        }),
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const out = decodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", data: bytesToHex(reply.data) });
  return out.map((r) => ({ success: r.success, data: r.returnData }));
}

/** getPerpetualInfo returns a dynamic struct; the oracle fields sit at fixed head words: 2 = priceDecimals, 15 = oraclePNS, 16 = oracleTimestampSec. */
function decodeOracle(raw: Hex): Oracle {
  const hex = raw.slice(2);
  const word = (i: number) => BigInt("0x" + hex.slice((1 + i) * 64, (2 + i) * 64));
  const o = { price: word(15), ts: word(16), decimals: Number(word(2)) };
  if (o.price === 0n || o.ts === 0n || o.decimals > 36) throw new Error("oracle decode out of range");
  return o;
}

const candleSchema = z.object({ d: z.array(z.object({ c: z.number() })).min(1) });
/** Perpl REST (external API): close of the newest 1-minute candle, in the market's price decimals. */
const fetchRestPrice = (sender: HTTPSendRequester, base: string, perpId: number, nowMs: number): number => {
  const url = `${base}/api/v1/market-data/${perpId}/candles/60/${nowMs - 180_000}-${nowMs}`;
  const res = sender.sendRequest({ url, method: "GET" }).result();
  if (!ok(res)) throw new Error(`Perpl REST HTTP ${res.statusCode}`);
  const parsed = candleSchema.parse(json(res));
  return parsed.d[parsed.d.length - 1].c;
};

function writeReport(runtime: Runtime<Config>, client: EVMClient, receiver: Address, encoded: Hex, gasLimit: string): string {
  const report = runtime.report(prepareReportRequest(encoded)).result();
  const result = client.writeReport(runtime, { receiver, report, gasConfig: { gasLimit } }).result();
  if (result.txStatus !== TxStatus.SUCCESS) throw new Error(result.errorMessage ?? `write status ${result.txStatus}`);
  if (!result.txHash) throw new Error("write succeeded without a transaction hash");
  return bytesToHex(result.txHash);
}

const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const nowMs = Number(now) * 1000;
  const client = evmClient(runtime);
  const registry = cfg.registry as Address, tape = cfg.tape as Address, v2 = cfg.settlerV2 as Address, exchange = cfg.exchange as Address;
  const log: Record<string, unknown> = { mode: cfg.mode, now: now.toString() };

  // ---- read 1: next call id, live oracle per market, tape size per market
  const r1 = multicall(runtime, client, [
    { target: registry, data: encodeFunctionData({ abi: registryAbi, functionName: "nextCallId" }) },
    ...cfg.markets.map((m) => ({ target: exchange, data: (GET_PERP_INFO + BigInt(m).toString(16).padStart(64, "0")) as Hex })),
    ...cfg.markets.map((m) => ({ target: tape, data: encodeFunctionData({ abi: tapeAbi, functionName: "sampleCount", args: [BigInt(m)] }) })),
  ]);
  if (!r1[0].success) throw new Error("registry.nextCallId failed");
  const nextId = decodeFunctionResult({ abi: registryAbi, functionName: "nextCallId", data: r1[0].data }) as bigint;
  const oracles = new Map<number, Oracle>();
  const counts = new Map<number, bigint>();
  cfg.markets.forEach((m, i) => {
    const o = r1[1 + i];
    if (o.success) {
      try { oracles.set(m, decodeOracle(o.data)); } catch { /* an undecodable market is skipped, never guessed */ }
    }
    const c = r1[1 + cfg.markets.length + i];
    counts.set(m, c.success ? (decodeFunctionResult({ abi: tapeAbi, functionName: "sampleCount", data: c.data }) as bigint) : 0n);
  });

  // ---- read 2: the newest calls, their settlement proposals, and the newest tape sample per market
  const ids: bigint[] = [];
  for (let id = nextId - 1n; id >= 1n && ids.length < cfg.callWindow; id--) ids.push(id);
  const headMarkets = cfg.markets.filter((m) => (counts.get(m) ?? 0n) > 0n);
  const r2 = multicall(runtime, client, [
    ...ids.map((id) => ({ target: registry, data: encodeFunctionData({ abi: registryAbi, functionName: "getCall", args: [id] }) })),
    ...ids.map((id) => ({ target: v2, data: encodeFunctionData({ abi: settlerAbi, functionName: "proposals", args: [id] }) })),
    ...headMarkets.map((m) => ({ target: tape, data: encodeFunctionData({ abi: tapeAbi, functionName: "sampleAt", args: [BigInt(m), (counts.get(m) ?? 1n) - 1n] }) })),
  ]);
  const calls: CallInfo[] = [];
  const proposed = new Set<string>();
  ids.forEach((id, i) => {
    const g = r2[i];
    if (!g.success) return;
    const c = decodeFunctionResult({ abi: registryAbi, functionName: "getCall", data: g.data });
    calls.push({
      id, status: c.status, perpId: c.perpId, direction: c.direction, tpBps: c.tpBps, slBps: c.slBps, entryPNS: c.entryPNS,
      entryOracleTs: c.entryOracleTs, horizonEnd: c.horizonEnd, priceDecimals: c.priceDecimals,
    });
    const p = r2[ids.length + i];
    if (p.success && decodeFunctionResult({ abi: settlerAbi, functionName: "proposals", data: p.data })[0] !== 0n) proposed.add(id.toString());
  });
  const heads = new Map<number, TapeHead>();
  headMarkets.forEach((m, i) => {
    const s = r2[2 * ids.length + i];
    if (s.success) {
      const smp = decodeFunctionResult({ abi: tapeAbi, functionName: "sampleAt", data: s.data });
      heads.set(m, { count: counts.get(m) ?? 0n, lastTs: smp.ts, lastPrice: smp.price });
    }
  });
  const revealed = calls.filter((c) => c.status === REVEALED);
  log.calls = { scanned: calls.length, revealed: revealed.length };

  // ---- decide + external API + tape report
  const plan = planSampling(calls, oracles, heads, now);
  log.sampling = plan;
  let tapeTx: string | null = null;
  if (plan.perpIds.length > 0) {
    const http = new HTTPClient();
    const rest = plan.perpIds.map((m) => {
      try {
        return BigInt(http.sendRequest(runtime, fetchRestPrice, consensusMedianAggregation<number>())(cfg.perplApi, m, nowMs).result());
      } catch (e) {
        runtime.log(`Perpl REST unavailable for market ${m}: ${String(e)}`);
        return 0n; // 0 = REST unavailable; the tape still samples the oracle itself
      }
    });
    log.restPrices = plan.perpIds.map((m, i) => ({ market: m, rest: rest[i].toString(), oracle: oracles.get(m)?.price.toString() }));
    if (cfg.mode === "broadcast") {
      tapeTx = writeReport(
        runtime, client, tape,
        encodeAbiParameters(parseAbiParameters("uint256[] perpIds, uint128[] restPrices"), [plan.perpIds.map((m) => BigInt(m)), rest]),
        String(cfg.tapeGasBase + cfg.tapeGasPerMarket * plan.perpIds.length),
      );
    } else {
      log.wouldWriteTape = plan.perpIds;
    }
  }
  log.tapeTx = tapeTx;

  // ---- proposals for calls past their horizon whose endpoint is already on the tape
  const due = revealed.filter((c) => now >= c.horizonEnd && !proposed.has(c.id.toString()));
  const props: { id: bigint; index: bigint; touch: boolean; score: bigint }[] = [];
  if (due.length > 0) {
    // read 3: where the path starts and where the endpoint is, per due call
    const r3 = multicall(runtime, client, due.flatMap((c) => [
      { target: tape, data: encodeFunctionData({ abi: tapeAbi, functionName: "firstIndexAtOrAfter", args: [BigInt(c.perpId), c.entryOracleTs + 1n] }) },
      { target: tape, data: encodeFunctionData({ abi: tapeAbi, functionName: "firstIndexAtOrAfter", args: [BigInt(c.perpId), c.horizonEnd] }) },
    ]));
    const ranges = due.map((c, i) => {
      const a = r3[2 * i], b = r3[2 * i + 1];
      if (!a.success || !b.success) return null;
      const start = decodeFunctionResult({ abi: tapeAbi, functionName: "firstIndexAtOrAfter", data: a.data }) as bigint;
      const endIdx = decodeFunctionResult({ abi: tapeAbi, functionName: "firstIndexAtOrAfter", data: b.data }) as bigint;
      const cnt = counts.get(c.perpId) ?? 0n;
      if (endIdx >= cnt) return null; // no endpoint sample on the tape yet: wait for the next run
      return { c, start, endIdx };
    }).filter((x): x is { c: CallInfo; start: bigint; endIdx: bigint } => x !== null);
    // read 4: every sample from the path start to the endpoint, for all due calls in one multicall
    const wanted: { c: CallInfo; index: bigint }[] = [];
    for (const r of ranges) for (let i = r.start; i <= r.endIdx && wanted.length < 200; i++) wanted.push({ c: r.c, index: i });
    const r4 = multicall(runtime, client, wanted.map((w) => ({ target: tape, data: encodeFunctionData({ abi: tapeAbi, functionName: "sampleAt", args: [BigInt(w.c.perpId), w.index] }) })));
    const byCall = new Map<string, TapeSample[]>();
    wanted.forEach((w, i) => {
      if (!r4[i].success) return;
      const s = decodeFunctionResult({ abi: tapeAbi, functionName: "sampleAt", data: r4[i].data });
      const k = w.c.id.toString();
      byCall.set(k, [...(byCall.get(k) ?? []), { index: w.index, ts: s.ts, price: s.price }]);
    });
    for (const r of ranges) {
      const samples = byCall.get(r.c.id.toString()) ?? [];
      const endpoint = samples.find((s) => s.index === r.endIdx);
      if (!endpoint) continue;
      const p = pickProposal(r.c, samples.filter((s) => s.index < r.endIdx), endpoint);
      props.push({ id: r.c.id, ...p });
    }
  }
  log.proposals = props.map((p) => ({ callId: p.id.toString(), index: p.index.toString(), touch: p.touch, score: p.score.toString() }));
  let settlerTx: string | null = null;
  if (props.length > 0) {
    if (cfg.mode === "broadcast") {
      settlerTx = writeReport(
        runtime, client, v2,
        encodeAbiParameters(parseAbiParameters("uint256[] callIds, uint32[] idxs"), [props.map((p) => p.id), props.map((p) => Number(p.index))]),
        String(cfg.settlerGasBase + cfg.settlerGasPerCall * props.length),
      );
    } else {
      log.wouldWriteSettler = props.map((p) => p.id.toString());
    }
  }
  log.settlerTx = settlerTx;
  runtime.log(JSON.stringify(log));
  return JSON.stringify(log);
};

const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configParser: (raw: Uint8Array) => configSchema.parse(JSON.parse(new TextDecoder().decode(raw))) });
  await runner.run(initWorkflow);
}
