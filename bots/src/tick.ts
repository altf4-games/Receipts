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
export interface BotRuntime { spec: BotSpec; signer: Signer }

export interface Ctx {
  pc: PublicClient;
  deployment: Deployment;
  perplApi: string;
  masterSecret: Hex;
  /** pays gas for reveal / settle / expire (all permissionless or recoverable by any wallet) */
  keeper: Signer;
  nowSec: () => bigint;
  log: (e: Record<string, unknown>) => void;
  cadence?: Cadence;
  /** test hooks (never set in production) */
  opts?: { forceCommit?: boolean; horizonBaseOverride?: number; jitterMod?: number };
}

const GAS_MARGIN = 1.15; // Monad charges the gas LIMIT, so keep margins tight

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
  try {
    const hash = await signer.client.writeContract({ address, abi, functionName: fn, args, gas, account: signer.account, chain: signer.client.chain } as never);
    const rc = await ctx.pc.waitForTransactionReceipt({ hash, timeout: 45_000 });
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

/** One bot, one market: advance whatever stage its single open call is in, or commit a new one if it is time. */
async function handleMarket(ctx: Ctx, bot: BotRuntime, perpId: bigint) {
  const d = ctx.deployment;
  const curator = bot.signer.account.address;
  const id = (await ctx.pc.readContract({ address: d.callRegistry, abi: CALL, functionName: "openCallId", args: [curator, perpId] })) as bigint;
  const now = ctx.nowSec();
  const tag = { bot: bot.spec.handle, perpId, callId: id };

  if (id !== 0n) {
    const c = await getCall(ctx, id);
    if (c.status === Status.Sealed) {
      if (now > c.horizonEnd) {
        await send(ctx, ctx.keeper, d.callRegistry, CALL, "expire", [id], "expire", tag);
      } else if (now >= c.commitTime + BigInt(Math.floor(c.horizonSecs / 2))) {
        const rec = recoverParams({
          chainId: d.chainId, registry: d.callRegistry, curator, perpId, horizonSecs: c.horizonSecs,
          secret: botSecret(ctx.masterSecret, bot.spec.handle), onchainHash: c.hash,
        });
        if (!rec) {
          ctx.log({ evt: "CRITICAL_unrecoverable_call", ...tag, hash: c.hash, note: "wrong BOT_SECRET or params outside the candidate set; call will expire at -30%" });
          return;
        }
        await send(ctx, ctx.keeper, d.callRegistry, CALL, "reveal", [id, rec.direction, rec.tpBps, rec.slBps, rec.salt], "reveal", { ...tag, dir: rec.direction, tp: rec.tpBps, sl: rec.slBps });
      }
    } else if (c.status === Status.Revealed && now >= c.horizonEnd) {
      const o = await readOracle(ctx.pc, d.exchange, perpId);
      if (o.ts >= c.horizonEnd) {
        await send(ctx, ctx.keeper, d.settlerV1, SETTLER, "settle", [id], "settle", tag);
      } else {
        ctx.log({ evt: "waiting_for_oracle_sample", ...tag, oracleTs: o.ts, horizonEnd: c.horizonEnd });
      }
    }
    return;
  }

  // slot free: is it this pair's commit window?
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
  await send(ctx, bot.signer, d.callRegistry, CALL, "commit", [perpId, hash, horizon], "commit", { ...tag, horizon, strategy: bot.spec.strategy });
}

/** One full pass over every bot and market. Safe to run concurrently or twice; stateless. */
export async function tickAll(ctx: Ctx, bots: BotRuntime[]) {
  const t0 = Date.now();
  const kb = await ctx.pc.getBalance({ address: ctx.keeper.account.address });
  if (kb < MIN_KEEPER_BALANCE_WEI) ctx.log({ evt: "LOW_BALANCE_keeper", balanceWei: kb });
  for (const bot of bots) {
    for (const perpId of bot.spec.markets) {
      try {
        await handleMarket(ctx, bot, perpId);
      } catch (e) {
        ctx.log({ evt: "error", bot: bot.spec.handle, perpId, reason: shortErr(e) });
      }
    }
  }
  ctx.log({ evt: "tick", ms: Date.now() - t0, bots: bots.length });
}

/** One-time setup per bot: AUSD bond (from the real Agora faucet if needed), approve, register as isBot=true. */
export async function bootstrapBot(ctx: Ctx, bot: BotRuntime, faucet: Address) {
  const d = ctx.deployment;
  const who = bot.signer.account.address;
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
      const r = await send(ctx, bot.signer, faucet, faucetAbi as unknown as Abi, "requestFunds", [who], "bootstrap_faucet", { bot: bot.spec.handle });
      if (r?.ok) break;
      await new Promise((res) => setTimeout(res, 62_000)); // faucet: 1 call / 60 s, global
    }
  }
  await send(ctx, bot.signer, d.bondToken, erc20 as unknown as Abi, "approve", [d.curatorRegistry, 2n ** 256n - 1n], "bootstrap_approve", { bot: bot.spec.handle });
  await send(ctx, bot.signer, d.curatorRegistry, CURATORS, "register", [bot.spec.handle, bot.spec.metadataURI, true, BigInt(d.minBond)], "bootstrap_register", { bot: bot.spec.handle });
}
