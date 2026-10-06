# Receipts

Finfluencers delete their bad calls. On Receipts, they can't.

Receipts is a paid curation feed for market calls whose track record cannot be faked. A curator commits a hidden call as a hash on Monad. The same transaction snapshots Perpl's Chainlink-fed oracle price, so the entry price and time cannot be backdated. Subscribers get the plaintext early and check it against the onchain hash. Everyone sees it at reveal. Calls that are never revealed score as a maximum loss.

Entered in the **Social, Attention & Culture** track of Monad Metropolis (2026).

> **Status: working on Monad testnet.** Deployed and verified: the registries, both settlers, the price tape and Subscriptions. Running unattended: four labelled bot curators and a keeper (a GitHub Actions cron every 5 minutes, with Cloudflare Workers as a backup), and a Next.js app at https://receipts-app-rho-ashy.vercel.app with a live feed, per-second subscriptions, in-browser verification and email sign-in with a built-in wallet. SettlerV2, the settler that scores calls from the Chainlink CRE price tape, has been the active production settler since Oct 5, 2026 (tx `0xca4104eb11d237800655115357d04c17791f707d2f63c45b2e16298782559bed`). Also built: an Envio indexer (Monad testnet and mainnet), open ranker algorithms with an onchain registry, and the Nansen integration. Not built: the mainnet cross-chain flow.

## Try it

Open https://receipts-app-rho-ashy.vercel.app, press **Sign in** (any email, Privy creates a built-in wallet) or connect MetaMask on Monad testnet, then go to `/me` and press **Get free test money** (0.25 test MON for gas and 200 test dollars; nothing costs real money). Open a receipt marked *Sealed* from the curator `pradyum`, subscribe for ten minutes and press **Sign and unlock**: you get the call and a green "matches sealed commit at block N", computed in your browser. `/call/36` is a bot call settled through the price tape (chart, flags, dispute window), `/rankers` has the open rankers and the Nansen table, and `/new` publishes your own call.

## Deployed contracts (Monad testnet, chain 10143)

| Contract | Address | Verified |
|---|---|---|
| CuratorRegistry | `0x1e917319c379fd4e62Bf3207379E3d8bb1A468AF` | Sourcify `exact_match` |
| CallRegistry (frozen facts layer) | `0x1E9b6c2e6484CcbeA63F4567905012a28Fa1753C` | Sourcify `exact_match` |
| SettlerV1 (endpoint scoring, approximate) | `0xF39358B88cF73a1d9158f00b9D5E39A04543E03f` | Sourcify `exact_match` |
| Subscriptions (per-second AUSD streams) | `0xcbDFf5C6f618dEA573a4B0FE000AF712F85D661e` | Sourcify `exact_match` |
| PriceTape (oracle samples written via Chainlink CRE) | `0xC028FCBE295bFA67bD1aA17e1f467214cE0Bf814` | Sourcify `exact_match` |
| SettlerV2 (path-aware, disputable; active settler since Oct 5) | `0xBdCF5A34a13617f62FFB9d3155dF3fA2939e73Dc` | Sourcify `exact_match` |
| RankerRegistry (receipts for ranking algorithms) | `0xc1936e5Ce100B7801fffBe99339F1757A3049581` | Sourcify `exact_match` |

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
- **The keeper is a fallback, not a dependency.** The keeper (GitHub Actions, with Cloudflare Workers as a backup) also records the endpoint sample, proposes and finalizes through the same verified path, so settlement does not need anyone to run the CRE CLI. While a market has an open call it also records a path sample about every 15 minutes (one transaction for all markets that need one), which is what lets a take-profit or stop-loss touch inside the window be found. Monad bills gas on the limit, so this costs real MON: about 0.012 MON per market per sample.

What I tested live on Monad testnet (staging copy with a 60 s window, `live-tests/test/tape.live.test.ts` and `bots/test/live/v2.live.test.ts`): the tape equals the Exchange's oracle (independent raw decode); a forged report from a non-forwarder reverts at both receivers; a wrong proposal is overturned by a dispute; a settlement proposed by the real CRE workflow (`cre workflow simulate --broadcast`) and one finalized by the keeper alone both score exactly what an independent recomputation from the tape gives.

Honest limits:
- **The CRE workflow runs as a CLI simulation with broadcast, not as a deployed workflow.** Deployment needs a commercial arrangement with Chainlink that I did not pursue. The simulation sends real transactions through Chainlink's `MockKeystoneForwarder`, which does not verify DON signatures; this is why nothing in the design depends on authenticating the workflow.
- **Path resolution is the tape's density.** A touch between two samples is invisible, and the first sample at or after the horizon can lag the horizon (flagged when more than 180 s).
- **Calls settled before Oct 5, 21:15 IST were scored by SettlerV1** (endpoint only) and stay final. Since the switch, calls are settled through the tape: the first was #31 (proposed at 21:57 IST, finalized at about 22:12 IST, score +1.00%, flags 4); most calls since then carry flags 4.

## Nansen: smart money at the moment of the call

I use Nansen where it answers a question a subscriber actually has: was this curator going with the crowd or against it? For every revealed call, the receipt page shows what Nansen Smart Money was doing in that market in the 24 hours before the call was sealed, and whether the call went with or against that lean. Only trades before the commit time are counted, and a sealed call's direction is never compared (it is secret until reveal). `/rankers` has a "beats smart money" table that ranks curators by the Wilson lower bound of their win rate on calls made *against* the lean, so following the crowd and being right does not rank. Example from production: receipt #19 was LONG when Smart Money had opened about $173k long and $645k short BTC, and it won +0.45%.

**Endpoints I call** (REST, `https://api.nansen.ai`, header `apikey`):

| Endpoint | Used for | Cost I measured |
|---|---|---|
| `POST /api/v1/smart-money/perp-trades` | Smart Money new perp positions for BTC, ETH, SOL (`only_new_positions`, 168 h lookback, one page of 1000) | 5 credits per call |
| `POST /api/v1/profiler/address/related-wallets` (`chain: monad`) | wallets related to a curator's linked identity wallet, for same-operator clusters | 1 credit |
| `POST /api/v1/profiler/address/pnl-summary` (`chain: monad`) | realised PnL and win rate of that wallet on Monad mainnet | read from the `x-nansen-credits-cost` header |

I use the REST API directly. I did not use the Nansen CLI or MCP tools in the product.

**How it is wired**
- `app/lib/nansen.ts` is the only code that calls Nansen. The free plan is 100 credits once, then 10 a day, so pages never call Nansen. A daily Vercel cron (`/api/nansen/refresh`, secret-protected) stores the responses in Redis with the time they were fetched, and every Nansen panel says "as of". The client reads the remaining credits from Nansen's response headers and stops below a reserve of 12.
- The maths is pure and tested: `rankers/src/smartMoney.ts` (lean at a commit time, with/against, the ranker) and `rankers/src/clusters.ts` (same-operator clusters by union-find over shared funders or deployers). 14 of the 38 ranker tests cover these.
- Nansen has no testnet data and the protocol runs on Monad testnet. So a curator can link a **mainnet identity wallet** to their curator address: the wallet signs a message that names the curator (`CuratorRegistry.linkIdentity`, with a replay-proof nonce), so nobody can link a wallet they do not control. The form is on `/me`.

**What is real and what is not.** The Smart Money lean and the "beats smart money" table run on real Nansen data today. The wallet panel and the cluster flag are built, tested and call Nansen for real: I linked one wallet and Nansen answered both calls, with an empty result, because testnet curators have no mainnet history. I will not link wallets to fake a cluster, so those panels show that empty state. Limits that come from Nansen: Smart Money perp data is Hyperliquid only (Perpl is not covered), only the trailing 7 days are available, and I only started storing it on Oct 5, so earlier calls are not compared. Notes on friction are in the partner feedback I wrote while building.

## Perpl: the oracle as the trust anchor

Receipts is a track-record product, so it uses Perpl as a source of truth rather than as a trading venue. All of this runs on real Perpl state:
- **Onchain oracle.** `CallRegistry.commit` reads `Exchange.getPerpetualInfo` in the same transaction and stores the Chainlink Data Streams price (`oraclePNS`) and its timestamp as the entry. It checks `ignOracle` is false and the price is no older than 120 s. `PriceTape.sample` does the same read to build the price path used for take-profit and stop-loss settlement.
- **REST API.** The Chainlink CRE workflow calls Perpl's market-data candles (`/api/v1/market-data/:id/candles/60/:from-:to`) as its external API and records the gap to the oracle in a `CrossCheck` event. The candle price is never used to score a call.
- **Perpl events in the indexer.** The Envio indexer reads `AccountCreated` and `PositionOpened` / `PositionOpenedV2` from the Exchange (testnet and mainnet) to link a curator's wallet to its Perpl account and flag Perpl positions opened while their call was open.

## Operating it, and an outage I had

The bots and the keeper must run unattended, because an unrevealed call scores −30% and a revealed call needs someone to settle it. They run as one stateless tick (`bots/scripts/run-once.ts`): a GitHub Actions cron every 5 minutes is the primary runner, and the same tick runs on two Cloudflare Workers (cron, free plan) as a backup. Ticks are idempotent, so racing runners is harmless.

**The Cloudflare Free plan failed me twice.** On Oct 4 (about 2 h) and on Oct 6 from 08:10 to 12:55 IST both Workers returned `exceededResources` and then `scriptThrewException` until they recovered. Cloudflare's own analytics showed why: each run used 40 to 60 ms of CPU against the Free plan's 10 ms limit, which is tolerated until it is not. The second outage cost five bot calls (#48 to #52) that were never revealed and expired at −30%, permanently, because the registry is frozen. That is the penalty working as designed, and it is also visible in the bots' stats. I moved the primary runner to GitHub Actions the same day. The record is in `.github/workflows/keeper.yml`.

## Indexer and open rankers

`indexer/` is an Envio HyperIndex project covering the Receipts contracts on Monad testnet and Perpl's Exchange on testnet and mainnet. It derives per-curator scoreboards (equity curve, max drawdown, sums for confidence bounds), per-market stats, subscription revenue and daily Perpl analytics, and it flags a curator's own Perpl positions opened while a call was open. I check it against the chain with a live test that pins one block, waits for the indexer to reach it and compares every row (see `indexer/README.md`).

`rankers/` holds the ranking algorithms as pure functions (`raw`, `mean-per-call`, `luck-adjusted`, `hit-rate-wilson`). A ranker is registered on chain with its code location and git commit, so anyone can rerun the exact code. The README there reports a coin-flip simulation, including the case where the luck-adjusted rule does *not* beat plain summing.

## What a transaction costs

Gas on Monad is billed on the gas limit, not on gas used. These are medians from the Foundry unit tests (mock exchange); the keeper sends limit = estimate × 1.15, so a real transaction costs about 15% more. MON price column: gas × 102 gwei (the testnet price on Oct 6).

| Action | Gas (median) | ≈ MON |
|---|---|---|
| `commit` (oracle snapshot included) | 273,000 | 0.028 |
| `reveal` | 41,000 | 0.004 |
| `expire` | 49,000 | 0.005 |
| `settle` (SettlerV1) | 145,000 | 0.015 |
| `PriceTape.sample` (one market) | 118,000 | 0.012 |
| `propose` (SettlerV2) | 85,000 | 0.009 |
| `dispute` | 62,000 | 0.006 |
| `finalize` | 64,000 | 0.007 |
| `subscribe` | 120,000 | 0.012 |
| `cancel` | 58,000 | 0.006 |
| `claim` | 50,000 | 0.005 |

Keeping the tape dense (one sample about every 15 minutes for each market that has an open call) costs roughly 3 to 5 MON a day at the current call volume, which is why the keeper only does it while a call is open and only when its own balance is above 1 MON.

## Tests, and what they caught

| Suite | Count |
|---|---|
| Contract unit tests (Foundry, with fuzz tests and mutation checks on Subscriptions and SettlerV2) | 135 |
| Fork tests against the real Perpl Exchange | 11 |
| Bots unit tests (tick order, V2 keeper, path sampling) | 42 |
| Rankers (including a drift test: the app's copy of the rankers equals `rankers/src`) | 38 |
| Indexer (scoring maths and handlers with simulated events) | 18 |
| CRE workflow logic (bun) | 12 |
| Live tests that send real transactions on Monad testnet (13 core contracts, 4 subscriptions, 4 delivery API, 4 price tape and real CRE workflow, 2 keeper fallback, 2 human curators, 2 indexer vs chain) | 31, full output in `live-tests/results/2026-10-06.txt` |

Every claim in this README that says "tested live" means a real transaction and a read-back, not a mock. What they caught, in the order I found it:
- **Truncated market id (freeze review).** `Call.perpId` is a `uint32` but the allowlist accepted any `uint256`, so a large id would have truncated on commit and stuck a curator's slot and bond forever. Fixed with a guard and a test.
- **Instant settler swap (freeze review).** The owner could replace the settler at once. Now timelocked (6 hours) and `Ownable2Step`; live-tested.
- **The keeper ignored human curators.** My first real call (#19) would never have been settled, because the keeper only watched the bots' calls. Found by using the product; fixed with a sweep of the newest calls and a live test with a fresh wallet.
- **Public RPC rate limit.** A parallel scan of 12 reads hit "requests limited to 15/sec" and failed 4 of 5 live tests. Replaced with one Multicall3 call.
- **First CRE broadcast cost 0.08 MON** because I guessed an 800,000 gas limit. Limits are now sized from measured gas, since Monad bills the limit.
- **Starter funds reverted** on the first live call: 70,000 gas is not enough for a first-time token recipient (72,918 needed).
- **Fork tests were flaky** because the Agora faucet allows one request per 60 s for everybody; 2 of 11 failed when someone else had just used it.
- **Indexer details**: a contract cannot start before its chain's start block; simulated events below a start block are dropped; a schema change silently lost entity data until the indexer was stopped and restarted. A live test now compares every indexed row with the chain.
- **Cloudflare Free plan outages** (Oct 4 and Oct 6), described above.

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

## Pre-existing code

None. This repository's first commit is dated Oct 4, 2026 and everything in it was written for Monad Metropolis; the full commit history is the record.

## Use of AI

AI tools played a helpful role in building Receipts, from researching the Perpl, Chainlink CRE, Nansen, Envio and Aurora integration paths to drafting documentation, assisting with contract structure, creating unit tests, and supporting frontend development.

## License

MIT, see `LICENSE`.
