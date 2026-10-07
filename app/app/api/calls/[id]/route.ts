import { NextResponse } from "next/server";
import { verifyMessage, type Address, type Hex } from "viem";
import { accessMessage, deploymentOf, isSubscribed, plainKey, readOnchainCall, redis, type Plain } from "@/lib/delivery";

export const dynamic = "force-dynamic";
const WINDOW_SECS = 300;

/**
 * GET /api/calls/:id
 * Revealed/settled calls are public. Sealed calls need headers x-receipts-address, x-receipts-timestamp,
 * x-receipts-signature: a signature over `Receipts: read call <id> on <deployment> at <ts>` by an address with an
 * active on-chain subscription to the call's curator (or the curator itself). The response carries everything a
 * client needs to recompute the hash itself.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/calls/[id]">) {
  const url = new URL(req.url);
  const dep = deploymentOf(url.searchParams.get("deployment"));
  const rawId = (await ctx.params).id;
  if (!/^[0-9]{1,9}$/.test(rawId)) return NextResponse.json({ error: "unknown call" }, { status: 404 }); // plain decimal ids only (not 0x10, 1e3, " 5")
  const id = Number(rawId);
  const call = await readOnchainCall(dep, id);
  if (!call) return NextResponse.json({ error: "unknown call" }, { status: 404 });

  if (call.status === 1) {
    const addr = req.headers.get("x-receipts-address") as Address | null;
    const ts = Number(req.headers.get("x-receipts-timestamp"));
    const sig = req.headers.get("x-receipts-signature") as Hex | null;
    if (!addr || !sig || !Number.isInteger(ts)) return NextResponse.json({ error: "signature required for a sealed call" }, { status: 401 });
    if (Math.abs(Date.now() / 1000 - ts) > WINDOW_SECS) return NextResponse.json({ error: "signature expired" }, { status: 401 });
    let valid = false;
    try { valid = await verifyMessage({ address: addr, message: accessMessage(dep, id, ts), signature: sig }); } catch { valid = false; }
    if (!valid) return NextResponse.json({ error: "bad signature" }, { status: 401 });
    const allowed = addr.toLowerCase() === call.curator.toLowerCase() || (await isSubscribed(dep, addr, call.curator));
    if (!allowed) return NextResponse.json({ error: "no active subscription to this curator" }, { status: 403 });
  }

  const stored = await redis.get<Plain | string>(plainKey(dep, id));
  if (!stored) return NextResponse.json({ error: "plaintext not uploaded by the curator yet" }, { status: 404 });
  const plain: Plain = typeof stored === "string" ? JSON.parse(stored) : stored;
  return NextResponse.json({
    callId: id, deployment: dep, curator: call.curator, onchainHash: call.hash, commitBlock: call.commitBlock.toString(),
    status: call.status, plaintext: plain,
  });
}
