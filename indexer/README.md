# Receipts indexer (Envio HyperIndex)

One GraphQL endpoint for everything the app and the rankers read: curators, sealed calls and their scores, settlement proposals, the CRE price tape, subscriptions, ranker receipts, and Perpl's own account and position events on **Monad testnet (10143) and Monad mainnet (143)**.

The frontend's feed, curator pages and `/rankers` page read this endpoint; the ranker algorithms (`../rankers`) are pure functions over its data.

## What is indexed

| Chain | Contract | Events | Why |
|---|---|---|---|
| 10143 | CuratorRegistry | Registered, BondAdded, IdentityLinked/Unlinked, MetadataUpdated | curators, bots, linked wallets |
| 10143 | CallRegistry | Committed, Revealed, Expired, Closed, SettlerChanged | the call lifecycle and the settler rotation |
| 10143 | SettlerV1 / SettlerV2 | Settled / Proposed, Disputed, Finalized | exit prices, proposals and disputes |
| 10143 | PriceTape | Sampled, CrossCheck | the CRE-written oracle tape and its REST cross-checks |
| 10143 | Subscriptions | RateSet, Subscribed, Cancelled, Claimed | revenue and subscribers |
| 10143 | RankerRegistry | RankerRegistered, RankingPublished | every ranker has a receipt (author, code URI, git commit) |
| 10143 | Perpl Exchange | AccountCreated (from block 0), PositionOpened / PositionOpenedV2 (from the Receipts deploy block) | link a curator's wallet to its Perpl account and record skin in the game |
| 143 | Perpl Exchange | PositionOpened / PositionOpenedV2 | daily opened-position analytics on the real mainnet exchange |

## Derived entities (maintained by the handlers)

- `CuratorStats`: calls, settled, expired, invalid, wins, losses, sum and sum of squares of scores, best, worst, equity curve, peak and **max drawdown** (updated in close order). The sums feed the luck-adjusted ranker's confidence bound.
- `MarketStats`: calls, longs, shorts, settled, wins, tape samples, last oracle price per Perpl market.
- `CuratorRevenue` and `Subscription`: rate, deposits, refunds and claims per curator and subscriber.
- `PerplMarketDay`: opened positions, long/short split and notional per market per day, on both chains.
- `PerplCuratorTrade` and the `perpl*Lots` fields on `Call`: Perpl positions a curator opened **while one of their calls was open** (skin in the game; the call's direction is hidden until reveal, so the app compares both sides after the reveal).

Entities are per chain (`disable_default_cross_chain: true`), so the same id on two chains is two rows.

## Run it

Node 22+ and Docker (OrbStack or Docker Desktop) are needed for local runs.

```bash
cp .env.example .env     # ENVIO_API_TOKEN from https://envio.dev/app/api-tokens
pnpm install
pnpm codegen
pnpm dev                 # Postgres + Hasura in Docker; GraphQL at http://localhost:8080/v1/graphql (admin secret "testing")
pnpm test                # 18 tests: pure scoring maths + handlers driven with simulated events
```

## Tests, and what they check

- `test/stats.test.ts`: equity curve, drawdown, best/worst, win/loss rules and Perpl notional scaling, as pure functions.
- `test/handlers.test.ts`: every handler with simulated events, including the full call lifecycle, an expired call, an invalid reveal, a disputed SettlerV2 settlement, subscription roll-ups, the price tape, ranker receipts, the settler rotation, and the multichain Perpl analytics.
- **Live check L11** (`../live-tests/test/indexer.live.test.ts`): reads the production contracts straight from the chain at one pinned block, waits for the indexer to reach that block, and requires every `Call` row, every `CuratorStats` row, each market's tape counter and each curator's rate and handle to equal the recomputation from the contract reads. The recomputation orders closes by the registry's own `closeBlock`, not by the indexer's event order.

## Limits, stated plainly

- The Envio free development plan soft-limits an indexer at 100,000 events and deletes idle deployments, so the Perpl position events are indexed from the Receipts deploy block only and mainnet starts at the deploy-time head.
- Perpl position events are attributed to a curator only when the curator's wallet is the Perpl account owner (`AccountCreated`). None of the labelled bots trade on Perpl, so their skin-in-the-game fields are zero by design.
