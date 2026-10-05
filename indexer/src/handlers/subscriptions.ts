import { indexer } from "envio";

const zeroRevenue = (id: string) => ({ id, rate: 0n, subscribers: 0, totalDeposited: 0n, totalRefunded: 0n, claimed: 0n });

indexer.onEvent({ contract: "Subscriptions", event: "RateSet" }, async ({ event, context }) => {
  const id = event.params.curator.toLowerCase();
  const r = (await context.CuratorRevenue.get(id)) ?? zeroRevenue(id);
  context.CuratorRevenue.set({ ...r, rate: event.params.ratePerSec });
});

indexer.onEvent({ contract: "Subscriptions", event: "Subscribed" }, async ({ event, context }) => {
  const curator = event.params.curator.toLowerCase();
  const subscriber = event.params.subscriber.toLowerCase();
  const id = `${curator}-${subscriber}`;
  const prev = await context.Subscription.get(id);
  const topUp = prev !== undefined && prev.activeUntil > Number(event.params.start);
  context.Subscription.set({
    id, curator, subscriber, rate: event.params.rate,
    totalDeposited: (prev?.totalDeposited ?? 0n) + event.params.amount,
    totalRefunded: prev?.totalRefunded ?? 0n, totalPaidOnCancel: prev?.totalPaidOnCancel ?? 0n,
    start: Number(event.params.start), activeUntil: Number(event.params.activeUntil), payments: (prev?.payments ?? 0) + 1,
  });
  void topUp;
  const r = (await context.CuratorRevenue.get(curator)) ?? zeroRevenue(curator);
  context.CuratorRevenue.set({ ...r, subscribers: r.subscribers + (prev ? 0 : 1), totalDeposited: r.totalDeposited + event.params.amount });
});

indexer.onEvent({ contract: "Subscriptions", event: "Cancelled" }, async ({ event, context }) => {
  const curator = event.params.curator.toLowerCase();
  const id = `${curator}-${event.params.subscriber.toLowerCase()}`;
  const s = await context.Subscription.get(id);
  if (s) context.Subscription.set({ ...s, totalRefunded: s.totalRefunded + event.params.refunded, totalPaidOnCancel: s.totalPaidOnCancel + event.params.paidToCurator, activeUntil: event.block.timestamp });
  const r = (await context.CuratorRevenue.get(curator)) ?? zeroRevenue(curator);
  context.CuratorRevenue.set({ ...r, totalRefunded: r.totalRefunded + event.params.refunded });
});

indexer.onEvent({ contract: "Subscriptions", event: "Claimed" }, async ({ event, context }) => {
  const id = event.params.curator.toLowerCase();
  const r = (await context.CuratorRevenue.get(id)) ?? zeroRevenue(id);
  context.CuratorRevenue.set({ ...r, claimed: r.claimed + event.params.amount });
});
