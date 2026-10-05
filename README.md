# Receipts

Finfluencers delete their bad calls. On Receipts, they can't.

Receipts is a paid curation feed for market calls whose track record cannot be faked. A curator commits a hidden call as a hash on Monad. The same transaction snapshots Perpl's Chainlink-fed oracle price, so the entry price and time cannot be backdated. Subscribers get the plaintext early and check it against the onchain hash. Everyone sees it at reveal. Calls that are never revealed score as a maximum loss.

Entered in the **Social, Attention & Culture** track of Monad Metropolis (2026).

> **Status: work in progress.** Deployed and verified on Monad testnet: the registries, SettlerV1 and Subscriptions. Running: four labelled bot curators (Cloudflare Workers) and a Next.js app at https://receipts-app-rho-ashy.vercel.app with a live feed, per-second subscriptions and in-browser verification. Not built yet: the CRE settler, the indexer, the rankers and the commit flow for human curators. This README is filled in as each piece ships, with transaction hashes and addresses that can be read live.

## Deployed contracts (Monad testnet, chain 10143)

| Contract | Address | Verified |
|---|---|---|
| CuratorRegistry | `0x1e917319c379fd4e62Bf3207379E3d8bb1A468AF` | Sourcify `exact_match` |
| CallRegistry (frozen facts layer) | `0x1E9b6c2e6484CcbeA63F4567905012a28Fa1753C` | Sourcify `exact_match` |
| SettlerV1 (endpoint scoring, approximate) | `0xF39358B88cF73a1d9158f00b9D5E39A04543E03f` | Sourcify `exact_match` |
| Subscriptions (per-second AUSD streams) | `0xcbDFf5C6f618dEA573a4B0FE000AF712F85D661e` | Sourcify `exact_match` |

Parameters: minimum horizon 15 min, maximum 7 days, take-profit cap 30%, stop-loss cap 15%, unrevealed-call penalty −30%, bond 50 AUSD, oracle age limit 120 s, settler-rotation timelock 6 h. A separate staging deployment (60 s minimum horizon) exists for live tests; its addresses are in `deployments/`.

## Subscriptions and delivery

A subscriber deposits AUSD and the curator earns it by the second at the rate the curator set when the stream started. Cancelling refunds exactly the part not yet earned. All math is whole-number multiplication (rate × seconds), so there is no rounding: deposit = paid + refund. Fuzz tests and live tests on testnet check this against an independent recompute from block timestamps.

The plaintext of a sealed call is delivered by a small server (Next.js route handlers backed by Upstash Redis). I want to be plain about what that server is trusted for:

- **It sees the plaintext before reveal.** It is trusted for availability and confidentiality only. A subscriber who does not trust it cannot be protected from it reading the call early; encrypting to subscriber keys is future work.
- **It is never trusted for integrity.** It refuses to store a plaintext that does not hash to the onchain commit, and the browser recomputes the hash itself against the chain and shows "✓ matches sealed commit" or "✗ DOES NOT MATCH". A server that lied would be caught.
- **Reads need a signature.** A sealed call is returned only to a wallet that signs a short message (bound to the call, the deployment and a 5-minute window) and has an active onchain subscription to that curator, or is the curator.
- **The bots' calls are not in the store yet.** Their plaintext can be recomputed from a secret I hold; subscriptions to bots are not offered.

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
cd contracts && forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts && forge build
forge test --no-match-path 'test/fork/*'          # unit tests
cd ../app && pnpm install && pnpm dev               # needs KV_REST_API_URL / KV_REST_API_TOKEN (Upstash) for the delivery API
```

## Use of AI

AI tools played a helpful role in building Receipts, from researching the Perpl, Chainlink CRE, Nansen, Envio and Aurora integration paths to drafting documentation, assisting with contract structure, creating unit tests, and supporting frontend development.

## License

MIT, see `LICENSE`.
