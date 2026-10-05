# Receipts

Finfluencers delete their bad calls. On Receipts, they can't.

Receipts is a paid curation feed for market calls whose track record cannot be faked. A curator commits a hidden call as a hash on Monad. The same transaction snapshots Perpl's Chainlink-fed oracle price, so the entry price and time cannot be backdated. Subscribers get the plaintext early and check it against the onchain hash. Everyone sees it at reveal. Calls that are never revealed score as a maximum loss.

Entered in the **Social, Attention & Culture** track of Monad Metropolis (2026).

> **Status: work in progress.** Deployed and verified on Monad testnet: the registries, SettlerV1 and Subscriptions. Running: four labelled bot curators (Cloudflare Workers) and a Next.js app at https://receipts-app-rho-ashy.vercel.app with a live feed, per-second subscriptions and in-browser verification. Built and tested on testnet but not yet the active settler on production: the Chainlink CRE price tape and SettlerV2 (activation after a 6-hour timelock). Not built yet: the indexer and the rankers. This README is filled in as each piece ships, with transaction hashes and addresses that can be read live.

## Deployed contracts (Monad testnet, chain 10143)

| Contract | Address | Verified |
|---|---|---|
| CuratorRegistry | `0x1e917319c379fd4e62Bf3207379E3d8bb1A468AF` | Sourcify `exact_match` |
| CallRegistry (frozen facts layer) | `0x1E9b6c2e6484CcbeA63F4567905012a28Fa1753C` | Sourcify `exact_match` |
| SettlerV1 (endpoint scoring, approximate) | `0xF39358B88cF73a1d9158f00b9D5E39A04543E03f` | Sourcify `exact_match` |
| Subscriptions (per-second AUSD streams) | `0xcbDFf5C6f618dEA573a4B0FE000AF712F85D661e` | Sourcify `exact_match` |
| PriceTape (oracle samples written via Chainlink CRE) | `0xC028FCBE295bFA67bD1aA17e1f467214cE0Bf814` | Sourcify `exact_match` |
| SettlerV2 (path-aware, disputable; timelock proposed) | `0xBdCF5A34a13617f62FFB9d3155dF3fA2939e73Dc` | Sourcify `exact_match` |

Parameters: minimum horizon 15 min, maximum 7 days, take-profit cap 30%, stop-loss cap 15%, unrevealed-call penalty −30%, bond 50 AUSD, oracle age limit 120 s, settler-rotation timelock 6 h. A separate staging deployment (60 s minimum horizon) exists for live tests; its addresses are in `deployments/`.

## Subscriptions and delivery

A subscriber deposits AUSD and the curator earns it by the second at the rate the curator set when the stream started. Cancelling refunds exactly the part not yet earned. All math is whole-number multiplication (rate × seconds), so there is no rounding: deposit = paid + refund. Fuzz tests and live tests on testnet check this against an independent recompute from block timestamps.

The plaintext of a sealed call is delivered by a small server (Next.js route handlers backed by Upstash Redis). I want to be plain about what that server is trusted for:

- **It sees the plaintext before reveal.** It is trusted for availability and confidentiality only. A subscriber who does not trust it cannot be protected from it reading the call early; encrypting to subscriber keys is future work.
- **It is never trusted for integrity.** It refuses to store a plaintext that does not hash to the onchain commit, and the browser recomputes the hash itself against the chain and shows "✓ matches sealed commit" or "✗ DOES NOT MATCH". A server that lied would be caught.
- **Reads need a signature.** A sealed call is returned only to a wallet that signs a short message (bound to the call, the deployment and a 5-minute window) and has an active onchain subscription to that curator, or is the curator.
- **The bots' calls are not in the store yet.** Their plaintext can be recomputed from a secret I hold; subscriptions to bots are not offered.

## Chainlink CRE: the price tape and SettlerV2

SettlerV1 scores a call at the end only and lets whoever settles pick which post-horizon oracle sample to use. SettlerV2 fixes both with a price tape written by a Chainlink CRE workflow (`cre/tape-and-settle`, TypeScript).

What the workflow does on each run (cron, at most every 30 s):
1. Reads the newest calls, the live Perpl oracle price and the tape state with a few Multicall3 EVM reads.
2. Calls **Perpl's REST API** (an external API) for the last traded price of each market that needs a sample.
3. Writes a report to `PriceTape` only when needed: while a revealed call's take-profit or stop-loss is touched by the live oracle, or when a call's horizon has passed and the tape has no sample after it. On Monad gas is charged on the gas limit, so a continuous tape would cost too much MON.
4. For revealed calls past their horizon whose endpoint is on the tape, finds the first sample that touches take-profit or stop-loss and writes a proposal report to `SettlerV2`.

How I made it trustworthy without trusting the workflow:
- **The tape never believes a price it is handed.** `PriceTape` reads the Perpl Exchange's oracle itself inside the transaction and appends the sample only if it is newer than the last one. A forged report can at most trigger a true sample. The REST price from the workflow is stored only as a `CrossCheck` event with the divergence in basis points, never used for scoring.
- **`SettlerV2` never believes a claim.** A proposal is checked against the tape: a path sample must really touch take-profit or stop-loss, and an endpoint must be the first sample at or after the horizon, so nobody can pick a convenient one. Anyone can dispute with an earlier touching sample during a window (900 s on production); after it, anyone can finalize and the registry closes the call. Every step costs O(1) gas.
- **The keeper is a fallback, not a dependency.** The bots' Cloudflare Worker also records the endpoint sample, proposes and finalizes (same verified path), so settlement does not need anyone to run the CRE CLI.

What I tested live on Monad testnet (staging copy with a 60 s window, `live-tests/test/tape.live.test.ts` and `bots/test/live/v2.live.test.ts`): the tape equals the Exchange's oracle (independent raw decode); a forged report from a non-forwarder reverts at both receivers; a wrong proposal is overturned by a dispute; a settlement proposed by the real CRE workflow (`cre workflow simulate --broadcast`) and one finalized by the keeper alone both score exactly what an independent recomputation from the tape gives.

Honest limits:
- **The CRE workflow runs as a CLI simulation with broadcast, not as a deployed workflow.** Deployment needs a commercial arrangement with Chainlink that I did not pursue. The simulation sends real transactions through Chainlink's `MockKeystoneForwarder`, which does not verify DON signatures; this is why nothing in the design depends on authenticating the workflow.
- **Path resolution is the tape's density.** A touch between two samples is invisible, and the first sample at or after the horizon can lag the horizon (flagged when more than 180 s).
- **SettlerV2 on production becomes the registry's settler only after a 6-hour timelock** that I proposed on 5 Oct 2026; calls already settled by SettlerV1 stay final.

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
