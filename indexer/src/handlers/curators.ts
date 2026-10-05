import { indexer } from "envio";
import { emptyStats } from "../lib/stats.js";

indexer.onEvent({ contract: "CuratorRegistry", event: "Registered" }, async ({ event, context }) => {
  const id = event.params.curator.toLowerCase();
  const perpl = await context.PerplAddress.get(id);
  context.Curator.set({
    id,
    handle: event.params.handle,
    isBot: event.params.isBot,
    bond: event.params.bond,
    registeredBlock: event.block.number,
    registeredAt: event.block.timestamp,
    metadataURI: "",
    linkedWallets: [],
    perplAccountId: perpl?.accountId,
  });
  context.CuratorStats.set({ id, curator_id: id, ...emptyStats() });
  context.CuratorRevenue.set({ id, rate: 0n, subscribers: 0, totalDeposited: 0n, totalRefunded: 0n, claimed: 0n });
});

indexer.onEvent({ contract: "CuratorRegistry", event: "BondAdded" }, async ({ event, context }) => {
  const c = await context.Curator.get(event.params.curator.toLowerCase());
  if (c) context.Curator.set({ ...c, bond: event.params.newBond });
});

indexer.onEvent({ contract: "CuratorRegistry", event: "IdentityLinked" }, async ({ event, context }) => {
  const c = await context.Curator.get(event.params.curator.toLowerCase());
  const w = event.params.wallet.toLowerCase();
  if (c && !c.linkedWallets.includes(w)) context.Curator.set({ ...c, linkedWallets: [...c.linkedWallets, w] });
});

indexer.onEvent({ contract: "CuratorRegistry", event: "IdentityUnlinked" }, async ({ event, context }) => {
  const c = await context.Curator.get(event.params.curator.toLowerCase());
  const w = event.params.wallet.toLowerCase();
  if (c) context.Curator.set({ ...c, linkedWallets: c.linkedWallets.filter((x) => x !== w) });
});

indexer.onEvent({ contract: "CuratorRegistry", event: "MetadataUpdated" }, async ({ event, context }) => {
  const c = await context.Curator.get(event.params.curator.toLowerCase());
  if (c) context.Curator.set({ ...c, metadataURI: event.params.metadataURI });
});
