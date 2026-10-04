/** One-time: register every bot as isBot=true (AUSD bond from the real faucet). Usage: tsx scripts/bootstrap.ts <production|staging> */
import { bootstrapBot } from "../src/tick.js";
import { buildNodeCtx, repoRoot } from "../src/node.js";
import path from "node:path";

const deploy = (process.argv[2] ?? "") as "production" | "staging";
if (deploy !== "production" && deploy !== "staging") throw new Error("usage: bootstrap <production|staging>");
const { ctx, bots } = buildNodeCtx(deploy, path.join(repoRoot, "docs", "bot-logs", `bootstrap-${deploy}.jsonl`));
const FAUCET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C";
for (const b of bots) await bootstrapBot(ctx, b, FAUCET);
ctx.log({ evt: "bootstrap_done" });
