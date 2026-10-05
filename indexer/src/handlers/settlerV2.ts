import { indexer } from "envio";

indexer.onEvent({ contract: "SettlerV2", event: "Proposed" }, async ({ event, context }) => {
  context.SettlementProposal.set({
    id: String(event.params.callId), index: Number(event.params.index), touch: event.params.touch, scoreBps: Number(event.params.scoreBps),
    proposedBy: event.params.by.toLowerCase(), proposedAt: event.block.timestamp, disputed: false, finalized: false,
  });
});

indexer.onEvent({ contract: "SettlerV2", event: "Disputed" }, async ({ event, context }) => {
  const id = String(event.params.callId);
  const p = await context.SettlementProposal.get(id);
  if (p) context.SettlementProposal.set({ ...p, index: Number(event.params.newIndex), touch: true, scoreBps: Number(event.params.scoreBps), disputed: true });
});

indexer.onEvent({ contract: "SettlerV2", event: "Finalized" }, async ({ event, context }) => {
  const id = String(event.params.callId);
  const p = await context.SettlementProposal.get(id);
  if (p) context.SettlementProposal.set({ ...p, finalized: true, scoreBps: Number(event.params.scoreBps) });
});
