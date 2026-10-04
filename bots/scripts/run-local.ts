/**
 * Local always-on runner (stand-in until the Cloudflare cron is live; both are stateless so they can overlap safely).
 * Usage: tsx scripts/run-local.ts <production|staging> [intervalSecs=60]
 */
import path from "node:path";
import { tickAll } from "../src/tick.js";
import { buildNodeCtx, repoRoot } from "../src/node.js";

const deploy = (process.argv[2] ?? "") as "production" | "staging";
if (deploy !== "production" && deploy !== "staging") throw new Error("usage: run-local <production|staging> [intervalSecs]");
const interval = Number(process.argv[3] ?? 60) * 1000;
const { ctx, bots } = buildNodeCtx(deploy, path.join(repoRoot, "docs", "bot-logs", `${deploy}.jsonl`));
ctx.log({ evt: "runner_start", interval, bots: bots.map((b) => b.spec.handle) });
for (;;) {
  const started = Date.now();
  try { await tickAll(ctx, bots); } catch (e) { ctx.log({ evt: "tick_crash", reason: String(e).slice(0, 200) }); }
  await new Promise((r) => setTimeout(r, Math.max(1000, interval - (Date.now() - started))));
}
