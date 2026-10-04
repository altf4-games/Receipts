import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { BOTS, type Deployment } from "./config.js";
import { makePublicClient, makeSigner } from "./chain.js";
import type { BotRuntime, Ctx } from "./tick.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
config({ path: path.join(repoRoot, ".env") });

export function buildNodeCtx(deployName: "production" | "staging", logFile?: string): { ctx: Ctx; bots: BotRuntime[] } {
  const rpc = process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";
  const deployment = JSON.parse(fs.readFileSync(path.join(repoRoot, "deployments", `${deployName}.json`), "utf8")) as Deployment;
  const key = (p: string) => {
    const v = process.env[`${p}_PRIVATE_KEY`] as Hex | undefined;
    if (!v) throw new Error(`missing ${p}_PRIVATE_KEY`);
    return v;
  };
  const master = process.env.BOT_SECRET as Hex | undefined;
  if (!master) throw new Error("missing BOT_SECRET");
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const ctx: Ctx = {
    pc: makePublicClient(rpc),
    deployment,
    perplApi: process.env.PERPL_API ?? "https://testnet.perpl.xyz/api",
    masterSecret: master,
    keeper: makeSigner(rpc, key("KEEPER")),
    nowSec: () => BigInt(Math.floor(Date.now() / 1000)),
    log: (e) => {
      const line = JSON.stringify({ at: new Date().toISOString(), deploy: deployName, ...e }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      console.log(line);
      if (logFile) fs.appendFileSync(logFile, line + "\n");
    },
  };
  const bots: BotRuntime[] = BOTS.map((spec) => ({ spec, signer: makeSigner(rpc, key(spec.envPrefix)) }));
  return { ctx, bots };
}
