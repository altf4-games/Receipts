import type { Address, Hex } from "viem";
import { MARKETS } from "./config";
import type { CallView, Status } from "./calls";
import { CALL_FIELDS, envio, type EnvioCall } from "./envio";

const STATUS: Record<EnvioCall["status"], Status> = { SEALED: "Sealed", REVEALED: "Revealed", SETTLED: "Settled", EXPIRED: "Expired", INVALID: "Invalid" };

function fmtPrice(pns: bigint, decimals: number): string {
  const s = pns.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** Map an Envio call row to the shape the Receipt component renders. */
export function toCallView(c: EnvioCall): CallView {
  return {
    id: c.callId, curator: c.curator.id as Address, handle: c.curator.handle, isBot: c.curator.isBot,
    market: MARKETS[c.perpId] ?? `perp ${c.perpId}`, perpId: c.perpId, status: STATUS[c.status],
    direction: c.direction === 1 ? "LONG" : c.direction === 2 ? "SHORT" : null, tpBps: c.tpBps, slBps: c.slBps, scoreBps: c.scoreBps,
    flags: c.flags ?? 0, horizonSecs: c.horizonSecs, commitBlock: BigInt(c.commitBlock), commitTime: c.commitTime, horizonEnd: c.horizonEnd,
    entryOracleTs: c.entryOracleTs, revealBlock: BigInt(0), closeBlock: BigInt(0), entryPrice: fmtPrice(BigInt(c.entryPNS), c.priceDecimals), hash: c.hash as Hex,
  };
}

export async function latestCalls(limit: number): Promise<{ calls: CallView[]; total: number }> {
  const d = await envio<{ Call: EnvioCall[]; CuratorStats: { calls: number }[] }>(
    `{ Call(limit:${limit}, order_by:{callId:desc}, where:{chainId:{_eq:10143}}) { ${CALL_FIELDS} } CuratorStats(where:{chainId:{_eq:10143}}) { calls } }`,
  );
  return { calls: d.Call.map(toCallView), total: d.CuratorStats.reduce((n, s) => n + s.calls, 0) };
}
