import { NextResponse } from "next/server";
import { isHex, type Address } from "viem";
import { DEPLOYMENTS } from "@/lib/config";
import { deploymentOf, hashPlain, plainKey, readOnchainCall, redis, type Plain } from "@/lib/delivery";

export const dynamic = "force-dynamic";

/**
 * POST /api/calls  { callId, perpId, direction, tpBps, slBps, horizonSecs, salt }
 * The caller proves authorship by possessing a preimage that hashes to the on-chain commit; no signature is needed
 * because the hash already binds the curator address. Anything that does not match the chain is rejected.
 */
export async function POST(req: Request) {
  const dep = deploymentOf(new URL(req.url).searchParams.get("deployment"));
  const raw = await req.text();
  if (raw.length > 2048) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }

  const callId = Number(b.callId);
  const p: Plain = {
    perpId: Number(b.perpId), direction: Number(b.direction) as 1 | 2, tpBps: Number(b.tpBps), slBps: Number(b.slBps),
    horizonSecs: Number(b.horizonSecs), salt: b.salt as `0x${string}`,
  };
  const ok =
    Number.isInteger(callId) && (p.direction === 1 || p.direction === 2) &&
    [p.perpId, p.tpBps, p.slBps, p.horizonSecs].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff) &&
    isHex(p.salt, { strict: true }) && p.salt.length === 66;
  if (!ok) return NextResponse.json({ error: "invalid fields" }, { status: 400 });

  const call = await readOnchainCall(dep, callId);
  if (!call) return NextResponse.json({ error: "unknown call" }, { status: 404 });
  if (call.status !== 1 && call.status !== 2) return NextResponse.json({ error: "call is not sealed or revealed" }, { status: 409 });
  const h = hashPlain(DEPLOYMENTS[dep].callRegistry as Address, call.curator, p);
  if (h !== call.hash) return NextResponse.json({ error: "plaintext does not match the on-chain commit" }, { status: 422 });

  await redis.set(plainKey(dep, callId), JSON.stringify(p));
  return NextResponse.json({ ok: true, callId, hash: h });
}
