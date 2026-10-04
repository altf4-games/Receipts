import type { Address, Hex, PublicClient } from "viem";

const wordsOf = (data: Hex) => {
  const hex = data.slice(2);
  // struct head starts after the outer offset word; head word i is at hex offset (1 + i) * 64
  return (i: number) => BigInt("0x" + hex.slice((1 + i) * 64, (2 + i) * 64));
};
const toSigned256 = (v: bigint) => (v >= 1n << 255n ? v - (1n << 256n) : v);

async function rawInfo(pc: PublicClient, exchange: Address, perpId: bigint, blockNumber?: bigint) {
  const data = ("0x00092cce" + perpId.toString(16).padStart(64, "0")) as Hex;
  const r = await pc.call({ to: exchange, data, blockNumber });
  if (!r.data) throw new Error(`empty getPerpetualInfo(${perpId})`);
  return wordsOf(r.data);
}

/** Independent raw decode (no struct ABI): oraclePNS = head word 15, oracleTs = 16, decimals = 2. */
export async function readOracle(pc: PublicClient, exchange: Address, perpId: bigint, blockNumber?: bigint) {
  const w = await rawInfo(pc, exchange, perpId, blockNumber);
  return { price: w(15), ts: w(16), decimals: Number(w(2)) };
}

/** Signed fundingRatePct100k = head word 20 (int16, sign-extended in its 32-byte word). */
export async function readFundingRate(pc: PublicClient, exchange: Address, perpId: bigint): Promise<bigint> {
  const w = await rawInfo(pc, exchange, perpId);
  return toSigned256(w(20));
}

/** Last ~3h of 5-minute closes from Perpl's public REST API (timestamps in ms). */
export async function fetchCloses(perplApi: string, perpId: bigint, nowMs: number): Promise<number[]> {
  const from = nowMs - 3 * 3600 * 1000;
  const res = await fetch(`${perplApi}/v1/market-data/${perpId}/candles/300/${from}-${nowMs}`);
  if (!res.ok) throw new Error(`perpl candles ${perpId}: HTTP ${res.status}`);
  const j = (await res.json()) as { d: { c: number }[] };
  return j.d.map((c) => c.c);
}
