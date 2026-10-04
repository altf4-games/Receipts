# Receipts

Finfluencers delete their bad calls. On Receipts, they can't.

Receipts is a paid curation feed for market calls whose track record cannot be faked. A curator commits a hidden call as a hash on Monad. The same transaction snapshots Perpl's Chainlink-fed oracle price, so the entry price and time cannot be backdated. Subscribers get the plaintext early and check it against the onchain hash. Everyone sees it at reveal. Calls that are never revealed score as a maximum loss.

Entered in the **Social, Attention & Culture** track of Monad Metropolis (2026).

> **Status: work in progress.** The core contracts are deployed and verified on Monad testnet. Bots, delivery, the CRE settler, the indexer and the app are not built yet. This README is filled in as each piece ships, with transaction hashes and addresses that can be read live.

## Deployed contracts (Monad testnet, chain 10143)

| Contract | Address | Verified |
|---|---|---|
| CuratorRegistry | `0x1e917319c379fd4e62Bf3207379E3d8bb1A468AF` | Sourcify `exact_match` |
| CallRegistry (frozen facts layer) | `0x1E9b6c2e6484CcbeA63F4567905012a28Fa1753C` | Sourcify `exact_match` |
| SettlerV1 (endpoint scoring, approximate) | `0xF39358B88cF73a1d9158f00b9D5E39A04543E03f` | Sourcify `exact_match` |

Parameters: minimum horizon 15 min, maximum 7 days, take-profit cap 30%, stop-loss cap 15%, unrevealed-call penalty −30%, bond 50 AUSD, oracle age limit 120 s, settler-rotation timelock 6 h. A separate staging deployment (60 s minimum horizon) exists for live tests; its addresses are in `deployments/`.

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
