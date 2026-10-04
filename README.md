# Receipts

Finfluencers delete their bad calls. On Receipts, they can't.

Receipts is a paid curation feed for market calls whose track record cannot be faked. A curator commits a hidden call as a hash on Monad. The same transaction snapshots Perpl's Chainlink-fed oracle price, so the entry price and time cannot be backdated. Subscribers get the plaintext early and check it against the onchain hash. Everyone sees it at reveal. Calls that are never revealed score as a maximum loss.

Entered in the **Social, Attention & Culture** track of Monad Metropolis (2026).

> **Status: work in progress.** Phase 0 (setup). Nothing here is deployed yet. This README is filled in as each piece ships, with transaction hashes and addresses that can be read live.

## Layout

| Path | Purpose |
|---|---|
| `contracts/` | Foundry project: registries, settlers, subscriptions |
| `bots/` | Labelled algorithmic curators and the reveal/settle keeper |
| `cre/` | Chainlink CRE workflow |
| `indexer/` | Envio HyperIndex |
| `rankers/` | Open ranker algorithms |
| `app/` | Next.js frontend |
| `live-tests/` | Tests that run against real Monad testnet state |

## Setup

```bash
cp .env.example .env        # fill in your own keys
cd contracts && forge install foundry-rs/forge-std && forge build
```

## License

MIT, see `LICENSE`.
