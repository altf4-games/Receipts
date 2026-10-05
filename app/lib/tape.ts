import { client } from "./calls";
import { priceTapeAbi, settlerV2Abi } from "./abi";
import { TAPE } from "./config";
import type { CallView } from "./calls";

export type TapePoint = { ts: number; price: number };
export type TapeView = {
  points: TapePoint[]; // samples from the commit to the end of the window, oracle timestamps, display floats
  totalInWindow: number;
  decimals: number;
  proposal: { proposedAt: number; index: number; scoreBps: number; touch: boolean; disputed: boolean; finalized: boolean } | null;
};

const MAX_POINTS = 80;

/** Read the on-chain price tape for one call (production only). Floats are for drawing; the numbers that score are on chain. */
export async function getTape(c: CallView, decimals: number): Promise<TapeView> {
  const to = c.horizonEnd + 600; // a little past the horizon so the endpoint sample is visible
  const [first, count] = await Promise.all([
    client.readContract({ address: TAPE.priceTape, abi: priceTapeAbi, functionName: "firstIndexAtOrAfter", args: [BigInt(c.perpId), BigInt(c.entryOracleTs)] }),
    client.readContract({ address: TAPE.priceTape, abi: priceTapeAbi, functionName: "sampleCount", args: [BigInt(c.perpId)] }),
  ]);
  const idxs: bigint[] = [];
  for (let i = first; i < count && idxs.length < MAX_POINTS; i++) idxs.push(i);
  const rows = await Promise.all(idxs.map((i) => client.readContract({ address: TAPE.priceTape, abi: priceTapeAbi, functionName: "sampleAt", args: [BigInt(c.perpId), i] })));
  const inWin = rows.filter((r) => Number(r.ts) <= to);
  const d = 10 ** decimals;
  const p = await client.readContract({ address: TAPE.settlerV2, abi: settlerV2Abi, functionName: "proposals", args: [BigInt(c.id)] });
  return {
    points: inWin.map((r) => ({ ts: Number(r.ts), price: Number(r.price) / d })),
    totalInWindow: inWin.length,
    decimals,
    proposal: p[0] === BigInt(0) ? null : { proposedAt: Number(p[0]), index: p[1], scoreBps: p[2], touch: p[3], disputed: p[4], finalized: p[5] },
  };
}
