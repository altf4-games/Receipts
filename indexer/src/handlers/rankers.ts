import { indexer } from "envio";

indexer.onEvent({ contract: "RankerRegistry", event: "RankerRegistered" }, async ({ event, context }) => {
  context.Ranker.set({
    id: event.params.rankerId.toString(), author: event.params.author.toLowerCase(), name: event.params.name, codeURI: event.params.codeURI,
    gitCommit: event.params.gitCommit, registeredBlock: event.block.number, registeredAt: event.block.timestamp,
    lastPublishedRoot: undefined, lastPublishedAsOfBlock: undefined,
  });
});

indexer.onEvent({ contract: "RankerRegistry", event: "RankingPublished" }, async ({ event, context }) => {
  const r = await context.Ranker.get(event.params.rankerId.toString());
  if (r) context.Ranker.set({ ...r, lastPublishedRoot: event.params.merkleRoot, lastPublishedAsOfBlock: Number(event.params.asOfBlock) });
});
