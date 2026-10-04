/**
 * Cloudflare Worker entry: the SAME stateless tick as the Node runner, triggered by a cron every minute.
 * Secrets (keys, BOT_SECRET) come from `wrangler secret`; nothing is stored between invocations.
 * GET /tick?token=ADMIN_TOKEN[&force=1] runs one tick on demand (used for measuring CPU and for staging tests).
 */
import type { Hex } from "viem";
import production from "../../deployments/production.json" with { type: "json" };
import staging from "../../deployments/staging.json" with { type: "json" };
import { BOTS, type Deployment } from "./config.js";
import { makePublicClient, makeSigner } from "./chain.js";
import { tickAll, type BotRuntime, type Ctx } from "./tick.js";

export interface Env {
  DEPLOY: "production" | "staging";
  MONAD_RPC: string;
  PERPL_API: string;
  BOT_SECRET: Hex;
  KEEPER_PRIVATE_KEY: Hex;
  BOT_MOMENTUM_PRIVATE_KEY: Hex;
  BOT_FUNDING_PRIVATE_KEY: Hex;
  BOT_COINFLIP_PRIVATE_KEY: Hex;
  BOT_CONTRARIAN_PRIVATE_KEY: Hex;
  ADMIN_TOKEN?: string;
  /** staging-only test knobs */
  TEST_HORIZON_BASE?: string;
  TEST_JITTER_MOD?: string;
  /** staging measurement only: "1" makes every cron tick commit on free slots */
  TEST_FORCE?: string;
}

function build(env: Env, force: boolean, events: Record<string, unknown>[]): { ctx: Ctx; bots: BotRuntime[] } {
  const deployment = (env.DEPLOY === "production" ? production : staging) as unknown as Deployment;
  const ctx: Ctx = {
    pc: makePublicClient(env.MONAD_RPC),
    deployment,
    perplApi: env.PERPL_API,
    masterSecret: env.BOT_SECRET,
    keeper: makeSigner(env.MONAD_RPC, env.KEEPER_PRIVATE_KEY),
    nowSec: () => BigInt(Math.floor(Date.now() / 1000)),
    log: (e) => {
      const line = JSON.stringify({ deploy: env.DEPLOY, ...e }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      console.log(line);
      events.push(JSON.parse(line));
    },
  };
  if (env.DEPLOY === "staging") {
    ctx.cadence = { periodSecs: 3600, windowSecs: 0 }; // staging only commits when forced
    ctx.opts = {
      forceCommit: force,
      horizonBaseOverride: env.TEST_HORIZON_BASE ? Number(env.TEST_HORIZON_BASE) : undefined,
      jitterMod: env.TEST_JITTER_MOD ? Number(env.TEST_JITTER_MOD) : undefined,
    };
  }
  const bots: BotRuntime[] = BOTS.map((spec) => ({
    spec,
    signer: makeSigner(env.MONAD_RPC, env[`${spec.envPrefix}_PRIVATE_KEY` as keyof Env] as Hex),
  }));
  return { ctx, bots };
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    try {
      const events: Record<string, unknown>[] = [];
      const { ctx: c, bots } = build(env, env.DEPLOY === "staging" && env.TEST_FORCE === "1", events);
      ctx.waitUntil(
        tickAll(c, bots).catch((e) => {
          console.error(JSON.stringify({ evt: "worker_tick_failed", reason: String(e).slice(0, 300) }));
          throw e;
        }),
      );
    } catch (e) {
      // setup failures used to surface only as an empty "exception" outcome; make them visible (names only, never values)
      console.error(JSON.stringify({
        evt: "worker_fatal",
        reason: String((e as Error)?.message ?? e).slice(0, 300),
        stack: String((e as Error)?.stack ?? "").slice(0, 400),
        envKeysPresent: Object.keys(env as unknown as Record<string, unknown>).sort(),
      }));
      throw e;
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/tick") return new Response("receipts-bots: stateless keeper + bot curators. See the repo README.\n", { status: 200 });
    if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) return new Response("forbidden\n", { status: 403 });
    const events: Record<string, unknown>[] = [];
    const { ctx, bots } = build(env, url.searchParams.get("force") === "1", events);
    await tickAll(ctx, bots);
    return Response.json({ events });
  },
};
