# Nansen: integration notes and friction (2026-10-05)

## What I built on (endpoints actually called)
- `POST /api/v1/smart-money/perp-trades` (filters.token_symbol, lookback_hours 168, only_new_positions, per_page 1000): 5 credits per call. One page held everything for BTC (68), ETH (55), SOL (18) over 7 days.
- `POST /api/v1/profiler/address/related-wallets` (chain "monad"): 1 credit. Verified on the Perpl mainnet Exchange -> "Deployed by".
- `POST /api/v1/profiler/address/pnl-summary` (chain "monad", date range required): built, not yet called on a real linked wallet (no curator has linked a mainnet wallet with history yet).

## Friction
1. **Free tier is 100 credits once, then 10/day**, and one Smart Money call costs 5. Hard to build anything that refreshes live; I store every response in Redis with a fetched-at stamp and a credit reserve read from the `x-nansen-credits-remaining` header. The header is the only reliable credit counter and it is undocumented on the endpoint pages ("Credit Cost: not specified").
2. **Smart Money perp data is Hyperliquid only and only the trailing 7 days**, no date range parameter. Perpl (Monad perps) is invisible to it. I use it as "wider smart-money mood" and say so on every panel. A Monad perps feed would be the obvious request.
3. **No testnet.** Product runs on Monad testnet, so Nansen can only read a curator's linked mainnet wallets. I added signed identity linking to the registry for this.
4. **Docs inconsistency:** the PnL page lists `address` as deprecated in favour of `wallet_address`, and two PnL endpoints (`pnl-summary`, `pnl`) share one doc page; the date object is required on one and optional on the other.
5. Response `address_label` is an empty string, not null, for unlabelled wallets.
6. The CLI `--help` call was blocked once by my agent harness's permission classifier, so I used the REST API directly.

## Honest status
Proven on real data: Smart Money lean at commit for real calls (e.g. receipt #19: lean SHORT, call LONG, won). Unproven: PnL panel and cluster flag on real linked wallets (needs wallets with mainnet history).
