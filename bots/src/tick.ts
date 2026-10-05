import {
  BaseError, ContractFunctionRevertedError,
  type Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type WalletClient, type Transport,
} from "viem";
import callAbi from "./abi/CallRegistry.json" with { type: "json" };
import curatorsAbi from "./abi/CuratorRegistry.json" with { type: "json" };
import settlerAbi from "./abi/SettlerV1.json" with { type: "json" };
import {
  DEFAULT_CADENCE, MIN_COMMIT_BALANCE_WEI, MIN_KEEPER_BALANCE_WEI,
  type BotSpec, type Cadence, type Deployment,
} from "./config.js";
import { botSecret, callHash, deriveSalt, inCommitWindow, jitteredHorizon, recoverParams } from "./params.js";
import { coinflip, contrarian, fundingFade, momentum, type Decision } from "./strategies.js";
import { fetchCloses, readFundingRate, readOracle } from "./market.js";
import { keeperV2, type DueCall } from "./v2.js";
import { samplePath } from "./sampling.js";

const CALL = callAbi as Abi;
const CURATORS = curatorsAbi as Abi;
const SETTLER = settlerAbi as Abi;

export enum Status { None, Sealed, Revealed, Settled, Expired, Invalid }
export interface Call {
  curator: Address; perpId: number; status: number; priceDecimals: number; direction: number; tpBps: number; slBps: number;
  flags: number; scoreBps: number; horizonSecs: number; commitBlock: bigint; commitTime: bigint; horizonEnd: bigint;
  entryOracleTs: bigint; revealBlock: bigint; closeBlock: bigint; entryPNS: bigint; hash: Hex;
}

export interface Signer { account: Account; client: WalletClient<Transport, Chain, Account> }
export interface BotRuntime { spec: BotSpec; address: Address; /** lazy: only built when a tx is sent */ getSigner: () => Signer }

export interface Ctx {
  pc: PublicClient;
  deployment: Deployment;
  perplApi: string;
  masterSecret: Hex;
  /** pays gas for reveal / settle / expire (all permissionless or recoverable by any wallet) */
  keeperAddress: Address;
  getKeeper: () => Signer;
  nowSec: () => bigint;
  log: (e: Record<string, unknown>) => void;
  cadence?: Cadence;
  /** test hooks (never set in production) */
  opts?: { forceCommit?: boolean; horizonBaseOverride?: number; jitterMod?: number };
  /** Max transactions one tick may send; the rest wait for the next tick. Bounds CPU, wall time and subrequests. Default 3. */
  maxTxPerTick?: number;
  /** internal per-tick counter */
  _sent?: number;
}

const GAS_MARGIN = 1.15; // Monad charges the gas LIMIT, so keep margins tight
const DEFAULT_MAX_TX_PER_TICK = 3;
const budgetLeft = (ctx: Ctx) => (ctx._sent ?? 0) < (ctx.maxTxPerTick ?? DEFAULT_MAX_TX_PER_TICK);

function shortErr(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "revert";
    return e.shortMessage.slice(0, 160);
  }
  return String((e as Error)?.message ?? e).slice(0, 160);
}

/** Estimate first: it doubles as a simulation, so an already-done / racing action is skipped, not sent. */
async function send(
  ctx: Ctx, signer: Signer, address: Address, abi: Abi, fn: string, args: unknown[], label: string, extra: Record<string, unknown> = {},
): Promise<{ hash: Hex; ok: boolean } | null> {
  let est: bigint;
  try {
    est = await ctx.pc.estimateContractGas({ account: signer.account, address, abi, functionName: fn, args } as never);
  } catch (e) {
    ctx.log({ evt: "skip", label, reason: shortErr(e), ...extra });
    return null;
  }
  const gas = BigInt(Math.ceil(Number(est) * GAS_MARGIN));
  ctx._sent = (ctx._sent ?? 0) + 1;
  try {
    const hash = await signer.client.writeContract({ address, abi, functionName: fn, args, gas, account: signer.account, chain: signer.client.chain } as never);
    const rc = await ctx.pc.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 1000 });
    ctx.log({ evt: label, hash, status: rc.status, block: rc.blockNumber, gasLimit: gas, ...extra });
    return { hash, ok: rc.status === "success" };
  } catch (e) {
    ctx.log({ evt: "error", label, reason: shortErr(e), ...extra });
    return null;
  }
}

const getCall = async (ctx: Ctx, id: bigint) =>
  (await ctx.pc.readContract({ address: ctx.deployment.callRegistry, abi: CALL, functionName: "getCall", args: [id] })) as unknown as Call;

async function decide(ctx: Ctx, spec: BotSpec, perpId: bigint): Promise<Decision | null> {
  switch (spec.strategy) {
    case "coinflip": {
      const b = new Uint8Array(1);
      crypto.getRandomValues(b);
      return coinflip((b[0] & 1) as 0 | 1);
    }
    case "funding":
      return fundingFade(await readFundingRate(ctx.pc, ctx.deployment.exchange, perpId));
    case "momentum":
      return momentum(await fetchCloses(ctx.perplApi, perpId, Number(ctx.nowSec()) * 1000));
    case "contrarian":
      return contrarian(await fetchCloses(ctx.perplApi, perpId, Number(ctx.nowSec()) * 1000));
  }
}

interface OpenItem { bot: BotRuntime; perpId: bigint; id: bigint; c: Call }
/** A call by a human curator: the keeper can settle it or expire it, but never reveal it (only the curator holds the salt). */
interface HumanItem { id: bigint; c: Call }
/** How many of the newest call ids the keeper looks at for human curators' calls. */
const HUMAN_WINDOW = 40;

async function actHuman(ctx: Ctx, it: HumanItem) {
  const d = ctx.deployment;
  const tag = { human: it.c.curator, perpId: BigInt(it.c.perpId), callId: it.id };
  if (it.c.status === Status.Sealed) {
    await send(ctx, ctx.getKeeper(), d.callRegistry, CALL, "expire", [it.id], "expire", tag);
    return;
  }
  const o = await readOracle(ctx.pc, d.exchange, BigInt(it.c.perpId));
  if (o.ts >= it.c.horizonEnd) await send(ctx, ctx.getKeeper(), d.settlerV1, SETTLER, "settle", [it.id], "settle", tag);
  else ctx.log({ evt: "waiting_for_oracle_sample", ...tag, oracleTs: o.ts, horizonEnd: it.c.horizonEnd });
}

/** Deadline-sensitive: an unrevealed call that is overdue must be expired; one that is due must be revealed before horizonEnd. */
async function actUrgent(ctx: Ctx, it: OpenItem) {
  const d = ctx.deployment;
  const { bot, perpId, id, c } = it;
  const curator = bot.address;
  const tag = { bot: bot.spec.handle, perpId, callId: id };
  const now = ctx.nowSec();
  if (now > c.horizonEnd) {
    await send(ctx, ctx.getKeeper(), d.callRegistry, CALL, "expire", [id], "expire", tag);
    return;
  }
  const rec = recoverParams({
    chainId: d.chainId, registry: d.callRegistry, curator, perpId, horizonSecs: c.horizonSecs,
    secret: botSecret(ctx.masterSecret, bot.spec.handle), onchainHash: c.hash,
  });
  if (!rec) {
    ctx.log({ evt: "CRITICAL_unrecoverable_call", ...tag, hash: c.hash, note: "wrong BOT_SECRET or params outside the candidate set; call will expire at -30%" });
    return;
  }
  await send(ctx, ctx.getKeeper(), d.callRegistry, CALL, "reveal", [id, rec.direction, rec.tpBps, rec.slBps, rec.salt], "reveal", { ...tag, dir: rec.direction, tp: rec.tpBps, sl: rec.slBps });
}

async function actSettle(ctx: Ctx, it: OpenItem) {
  const d = ctx.deployment;
  const tag = { bot: it.bot.spec.handle, perpId: it.perpId, callId: it.id };
  const o = await readOracle(ctx.pc, d.exchange, it.perpId);
  if (o.ts >= it.c.horizonEnd) await send(ctx, ctx.getKeeper(), d.settlerV1, SETTLER, "settle", [it.id], "settle", tag);
  else ctx.log({ evt: "waiting_for_oracle_sample", ...tag, oracleTs: o.ts, horizonEnd: it.c.horizonEnd });
}

/** Free slot: commit only inside this pair's window (or when forced by a test). */
async function actCommit(ctx: Ctx, bot: BotRuntime, perpId: bigint) {
  const d = ctx.deployment;
  const curator = bot.address;
  const now = ctx.nowSec();
  const tag = { bot: bot.spec.handle, perpId, callId: 0n };
  const cad = ctx.cadence ?? DEFAULT_CADENCE;
  if (!ctx.opts?.forceCommit && !inCommitWindow(bot.spec.handle, perpId, now, cad.periodSecs, cad.windowSecs)) return;

  const bal = await ctx.pc.getBalance({ address: curator });
  if (bal < MIN_COMMIT_BALANCE_WEI) {
    ctx.log({ evt: "LOW_BALANCE_skip_commit", ...tag, balanceWei: bal });
    return;
  }
  const decision = await decide(ctx, bot.spec, perpId);
  if (!decision) {
    ctx.log({ evt: "no_signal", ...tag });
    return;
  }
  const horizon = jitteredHorizon(ctx.opts?.horizonBaseOverride ?? bot.spec.horizonBase, now, ctx.opts?.jitterMod);
  const salt = deriveSalt(botSecret(ctx.masterSecret, bot.spec.handle), perpId, horizon);
  const hash = callHash({ chainId: d.chainId, registry: d.callRegistry, curator, perpId, direction: decision.direction, tpBps: decision.tpBps, slBps: decision.slBps, horizonSecs: horizon, salt });
  await send(ctx, bot.getSigner(), d.callRegistry, CALL, "commit", [perpId, hash, horizon], "commit", { ...tag, horizon, strategy: bot.spec.strategy });
}

/**
 * One full pass over every bot and market. Safe to run concurrently or twice; stateless.
 * Work is ordered by urgency so the per-tick transaction cap can never starve a deadline:
 *   1. reveal / expire (a missed reveal costs -30%), soonest horizon first
 *   2. settle (can wait for the next tick)
 *   3. new commits (spend only what is left)
 */
export async function tickAll(ctx: Ctx, bots: BotRuntime[]) {
  const t0 = Date.now();
  let keeperBalance: bigint | null = null;
  try {
    const kb = await ctx.pc.getBalance({ address: ctx.keeperAddress });
    keeperBalance = kb;
    if (kb < MIN_KEEPER_BALANCE_WEI) ctx.log({ evt: "LOW_BALANCE_keeper", balanceWei: kb });
  } catch (e) {
    ctx.log({ evt: "error", label: "keeper_balance", reason: shortErr(e) }); // a flaky RPC must not abort the whole tick
  }
  ctx._sent = 0;
  let deferred = false;
  const now = ctx.nowSec();
  const urgent: OpenItem[] = [];
  const settles: OpenItem[] = [];
  const free: { bot: BotRuntime; perpId: bigint }[] = [];

  // scan: ONE Multicall3 eth_call reads every pair's open call id (public RPC allows only ~15 calls/s and Cloudflare Free
  // 50 subrequests/run; 12 separate reads is the wrong shape). A second multicall fetches the open calls' details.
  const pairs = bots.flatMap((bot) => bot.spec.markets.map((perpId) => ({ bot, perpId })));
  const openPairs: { bot: BotRuntime; perpId: bigint; id: bigint }[] = [];
  let nextCallId = 0n;
  let v2Active = false;
  try {
    const idRes = await ctx.pc.multicall({
      allowFailure: true,
      contracts: [
        ...pairs.map(({ bot, perpId }) => ({ address: ctx.deployment.callRegistry, abi: CALL, functionName: "openCallId", args: [bot.address, perpId] })),
        { address: ctx.deployment.callRegistry, abi: CALL, functionName: "nextCallId", args: [] },
        { address: ctx.deployment.callRegistry, abi: CALL, functionName: "settler", args: [] },
      ],
    } as never);
    const nextRes = (idRes as { status: string; result?: unknown }[])[pairs.length];
    if (nextRes?.status === "success") nextCallId = nextRes.result as bigint;
    const settlerRes = (idRes as { status: string; result?: unknown }[])[pairs.length + 1];
    // SettlerV2 mode: only when the registry's active settler really is the configured SettlerV2 (never guessed)
    if (settlerRes?.status === "success" && ctx.deployment.settlerV2 && (settlerRes.result as string).toLowerCase() === ctx.deployment.settlerV2.toLowerCase()) v2Active = true;
    (idRes as { status: string; result?: unknown }[]).slice(0, pairs.length).forEach((r, i) => {
      if (r.status !== "success") { ctx.log({ evt: "error", label: "scan", bot: pairs[i].bot.spec.handle, perpId: pairs[i].perpId, reason: "multicall item failed" }); return; }
      const id = r.result as bigint;
      if (id === 0n) free.push(pairs[i]);
      else openPairs.push({ ...pairs[i], id });
    });
  } catch (e) {
    ctx.log({ evt: "error", label: "scan", reason: shortErr(e) }); // whole scan failed (RPC down/limited): do nothing this tick, retry next
  }
  const humans: HumanItem[] = [];
  const pathPerps = new Set<number>(); // markets with a call still inside its window: they need path samples on the tape (V2)
  const openIds = new Set(openPairs.map((o) => o.id));
  const windowIds: bigint[] = [];
  for (let id = nextCallId - 1n; id >= 1n && windowIds.length < HUMAN_WINDOW; id--) if (!openIds.has(id)) windowIds.push(id);
  if (openPairs.length || windowIds.length) {
    try {
      const callRes = await ctx.pc.multicall({
        allowFailure: true,
        contracts: [...openPairs.map((o) => o.id), ...windowIds].map((id) => ({ address: ctx.deployment.callRegistry, abi: CALL, functionName: "getCall", args: [id] })),
      } as never);
      (callRes as { status: string; result?: unknown }[]).forEach((r, i) => {
        if (r.status !== "success") { ctx.log({ evt: "error", label: "scan_getCall", reason: "multicall item failed" }); return; }
        const c = r.result as unknown as Call;
        if (i >= openPairs.length) {
          // newest-first window of other calls: only unfinished ones past their horizon need the keeper
          const id = windowIds[i - openPairs.length];
          if ((c.status === Status.Sealed || c.status === Status.Revealed) && now < c.horizonEnd) pathPerps.add(Number(c.perpId));
          if (((c.status === Status.Sealed && now > c.horizonEnd) || (c.status === Status.Revealed && now >= c.horizonEnd))) humans.push({ id, c });
          return;
        }
        const o = openPairs[i];
        if ((c.status === Status.Sealed || c.status === Status.Revealed) && now < c.horizonEnd) pathPerps.add(Number(c.perpId));
        const it = { bot: o.bot, perpId: o.perpId, id: o.id, c };
        if (c.status === Status.Sealed && (now > c.horizonEnd || now >= c.commitTime + BigInt(Math.floor(c.horizonSecs / 2)))) urgent.push(it);
        else if (c.status === Status.Revealed && now >= c.horizonEnd) settles.push(it);
      });
    } catch (e) {
      ctx.log({ evt: "error", label: "scan_getCall", reason: shortErr(e) });
    }
  }
  urgent.sort((x, y) => (x.c.horizonEnd < y.c.horizonEnd ? -1 : x.c.horizonEnd > y.c.horizonEnd ? 1 : 0));

  const run = async (label: string, fn: () => Promise<void>, who: Record<string, unknown>) => {
    if (!budgetLeft(ctx)) { deferred = true; return; }
    try { await fn(); } catch (e) { ctx.log({ evt: "error", label, ...who, reason: shortErr(e) }); }
  };
  for (const it of urgent) await run("urgent", () => actUrgent(ctx, it), { bot: it.bot.spec.handle, perpId: it.perpId });
  if (v2Active) {
    // SettlerV2: unrevealed human calls are still expired; every revealed call past its horizon goes through the tape flow
    for (const h of humans.filter((x) => x.c.status === Status.Sealed)) await run("human", () => actHuman(ctx, h), { human: h.c.curator, callId: h.id });
    const due: DueCall[] = [...settles.map((x) => ({ id: x.id, c: x.c })), ...humans.filter((x) => x.c.status === Status.Revealed)];
    if (due.length && budgetLeft(ctx)) {
      try {
        await keeperV2(ctx, due, (c, address, abi, fn, args, label, extra) => send(c, c.getKeeper(), address, abi, fn, args, label, extra), () => budgetLeft(ctx));
      } catch (e) { ctx.log({ evt: "error", label: "v2", reason: shortErr(e) }); }
    }
    // after the deadline-sensitive work: keep the tape dense while calls are open (one tx for all markets that need a sample)
    if (pathPerps.size && budgetLeft(ctx)) {
      try {
        await samplePath(ctx, [...pathPerps], keeperBalance, (c, address, abi, fn, args, label, extra) => send(c, c.getKeeper(), address, abi, fn, args, label, extra), () => budgetLeft(ctx));
      } catch (e) { ctx.log({ evt: "error", label: "path_sample", reason: shortErr(e) }); }
    }
  } else {
    for (const it of settles) await run("settle", () => actSettle(ctx, it), { bot: it.bot.spec.handle, perpId: it.perpId });
    for (const h of humans) await run("human", () => actHuman(ctx, h), { human: h.c.curator, callId: h.id });
  }
  for (const f of free) await run("commit", () => actCommit(ctx, f.bot, f.perpId), { bot: f.bot.spec.handle, perpId: f.perpId });

  ctx.log({ evt: "tick", ms: Date.now() - t0, bots: bots.length, txSent: ctx._sent, deferred, urgent: urgent.length, settles: settles.length, humans: humans.length, v2: v2Active, free: free.length });
}

/** One-time setup per bot: AUSD bond (from the real Agora faucet if needed), approve, register as isBot=true. */
export async function bootstrapBot(ctx: Ctx, bot: BotRuntime, faucet: Address) {
  const d = ctx.deployment;
  const who = bot.address;
  const cur = (await ctx.pc.readContract({ address: d.curatorRegistry, abi: CURATORS, functionName: "getCurator", args: [who] })) as { registered: boolean };
  if (cur.registered) return ctx.log({ evt: "bootstrap_already_registered", bot: bot.spec.handle });
  const erc20 = [
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  ] as const;
  const faucetAbi = [{ type: "function", name: "requestFunds", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [] }] as const;
  const bal = (await ctx.pc.readContract({ address: d.bondToken, abi: erc20, functionName: "balanceOf", args: [who] })) as bigint;
  if (bal < BigInt(d.minBond)) {
    for (let i = 0; i < 6; i++) {
      const r = await send(ctx, bot.getSigner(), faucet, faucetAbi as unknown as Abi, "requestFunds", [who], "bootstrap_faucet", { bot: bot.spec.handle });
      if (r?.ok) break;
      await new Promise((res) => setTimeout(res, 62_000)); // faucet: 1 call / 60 s, global
    }
  }
  await send(ctx, bot.getSigner(), d.bondToken, erc20 as unknown as Abi, "approve", [d.curatorRegistry, 2n ** 256n - 1n], "bootstrap_approve", { bot: bot.spec.handle });
  await send(ctx, bot.getSigner(), d.curatorRegistry, CURATORS, "register", [bot.spec.handle, bot.spec.metadataURI, true, BigInt(d.minBond)], "bootstrap_register", { bot: bot.spec.handle });
}
