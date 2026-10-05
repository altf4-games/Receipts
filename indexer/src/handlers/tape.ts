import { indexer } from "envio";

indexer.onEvent({ contract: "PriceTape", event: "Sampled" }, async ({ event, context }) => {
  const perpId = Number(event.params.perpId);
  const index = Number(event.params.index);
  context.TapeSample.set({
    id: `${perpId}-${index}`, perpId, index, oracleTs: Number(event.params.oracleTs), price: event.params.price,
    writer: event.params.writer.toLowerCase(), block: event.block.number,
  });
  const m = (await context.MarketStats.get(String(perpId))) ?? {
    id: String(perpId), perpId, calls: 0, longs: 0, shorts: 0, settled: 0, expired: 0, wins: 0, sumScoreBps: 0, tapeSamples: 0,
    lastOraclePrice: undefined, lastOracleTs: undefined,
  };
  context.MarketStats.set({ ...m, tapeSamples: m.tapeSamples + 1, lastOraclePrice: event.params.price, lastOracleTs: Number(event.params.oracleTs) });
});

indexer.onEvent({ contract: "PriceTape", event: "CrossCheck" }, async ({ event, context }) => {
  context.CrossCheck.set({
    id: `${event.block.number}-${event.logIndex}`, perpId: Number(event.params.perpId), oraclePrice: event.params.oraclePrice,
    restPrice: event.params.restPrice, divergenceBps: Number(event.params.divergenceBps), block: event.block.number,
  });
});
