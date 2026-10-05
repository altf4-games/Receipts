import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { deploymentOf } from "@/lib/hash";
import { accountView } from "@/lib/subIndex";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /api/account?address=0x..&deployment=  : public on-chain data only (subscriptions where the address is curator or subscriber). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address");
  if (!address || !isAddress(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
  try {
    return NextResponse.json(await accountView(deploymentOf(u.searchParams.get("deployment")), address as Address));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.split("\n")[0] }, { status: 502 });
  }
}
