import { indexer } from "envio";
import { notionalMicroUsd, unixDay } from "../lib/stats.js";

indexer.onEvent({ contract: "PerplAccounts", event: "AccountCreated" }, async ({ event, context }) => {
  const address = event.params.account.toLowerCase();
  context.PerplAccount.set({ id: event.params.id.toString(), address });
  context.PerplAddress.set({ id: address, accountId: event.params.id });
  const curator = await context.Curator.get(address);
  if (curator) context.Curator.set({ ...curator, perplAccountId: event.params.id });
});

type OpenedParams = { perpId: bigint; accountId: bigint; positionType: bigint | number; pricePNS: bigint; lotLNS: bigint };

/** Shared by PositionOpened and PositionOpenedV2: daily market analytics + "skin in the game" for curators. */
async function onOpened(
  { event, context }: { event: { chainId: number; logIndex: number; block: { number: number; timestamp: number }; params: OpenedParams }; context: any },
) {
  const p = event.params;
  const perpId = Number(p.perpId);
  const isLong = Number(p.positionType) === 0; // Perpl PositionType: Long = 0, Short = 1
  const day = unixDay(event.block.timestamp);
  const id = `${perpId}-${day}`;
  const d = (await context.PerplMarketDay.get(id)) ?? { id, perpId, day, opens: 0, longOpens: 0, shortOpens: 0, notionalMicroUsd: 0n };
  context.PerplMarketDay.set({
    ...d, opens: d.opens + 1, longOpens: d.longOpens + (isLong ? 1 : 0), shortOpens: d.shortOpens + (isLong ? 0 : 1),
    notionalMicroUsd: d.notionalMicroUsd + notionalMicroUsd(event.chainId, perpId, p.lotLNS, p.pricePNS),
  });

  // is this Perpl account one of our curators, with an open call on this market?
  const acct = await context.PerplAccount.get(p.accountId.toString());
  if (!acct) return;
  const curator = await context.Curator.get(acct.address);
  if (!curator) return;
  const slot = await context.OpenSlot.get(`${curator.id}-${perpId}`);
  if (!slot) return;
  const call = await context.Call.get(String(slot.callId));
  if (!call) return;
  context.Call.set({
    ...call, perplTrades: call.perplTrades + 1,
    perplLongLots: call.perplLongLots + (isLong ? p.lotLNS : 0n), perplShortLots: call.perplShortLots + (isLong ? 0n : p.lotLNS),
  });
  context.PerplCuratorTrade.set({
    id: `${event.block.number}-${event.logIndex}`, curator_id: curator.id, callId: call.callId, perpId,
    positionType: Number(p.positionType), lotLNS: p.lotLNS, pricePNS: p.pricePNS, block: event.block.number,
    blocksSinceCommit: event.block.number - call.commitBlock,
  });
}

indexer.onEvent({ contract: "PerplTrades", event: "PositionOpened" }, onOpened as never);
indexer.onEvent({ contract: "PerplTrades", event: "PositionOpenedV2" }, onOpened as never);
