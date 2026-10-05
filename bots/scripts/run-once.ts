/**
 * Runs exactly one stateless tick and exits (events go to stdout as JSON lines).
 * Usage: tsx scripts/run-once.ts <production|staging>
 * Used for one-off checks and as the entry point for a CI cron runner; safe to run alongside the Workers.
 */
import path from "node:path";
import { tickAll } from "../src/tick.js";
import { buildNodeCtx, repoRoot } from "../src/node.js";

const deploy = (process.argv[2] ?? "") as "production" | "staging";
if (deploy !== "production" && deploy !== "staging") throw new Error("usage: run-once <production|staging>");
const { ctx, bots } = buildNodeCtx(deploy, path.join(repoRoot, "docs", "bot-logs", `${deploy}-once.jsonl`));
const log = ctx.log;
ctx.log = (e) => { console.log(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); log(e); };
await tickAll(ctx, bots);
