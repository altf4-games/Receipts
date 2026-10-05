import { readSmartMoney } from "./nansen";
import { alignment, leanAt, type Alignment, type Lean } from "./rankers";
import { MARKETS } from "./config";

export type SmContext = { lean: Lean; align: Alignment; fetchedAt: number } | null;

/** Smart Money positioning (Nansen, Hyperliquid) in the 24 h before a call was sealed, and how the call lined up with it. */
export async function smartMoneyFor(calls: { perpId: number; commitTime: number; direction: number | null }[]): Promise<{ ctx: SmContext[]; fetchedAt: number | null }> {
  const sm = await readSmartMoney().catch(() => null);
  if (!sm) return { ctx: calls.map(() => null), fetchedAt: null };
  return {
    fetchedAt: sm.fetchedAt,
    ctx: calls.map((c) => {
      const sym = MARKETS[c.perpId];
      if (!sym) return null;
      const lean = leanAt(sm.trades, sym, c.commitTime, sm.coveredFrom);
      return { lean, align: c.direction ? alignment(c.direction, lean) : "nodata", fetchedAt: sm.fetchedAt };
    }),
  };
}
