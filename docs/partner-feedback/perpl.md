# Partner feedback: perpl

Written as friction happens. Format: date · doc/endpoint · expected · actual (exact error text) · workaround · severity.


- 2026-10-04 · dex-sdk ABI / Exchange.getPerpetualInfo · expected a fixed-size struct (api-docs README gives no layout) · actual: returns a struct beginning with two dynamic `string` fields (name, symbol), so a naive fixed-offset decode of the raw return is wrong; the layout is only discoverable in `PerplFoundation/dex-sdk/crates/sdk/abi/dex/Exchange.json` (2 MB, not served by the GitHub contents API without the raw Accept header) · workaround: decode with the full tuple · severity: medium (silent mis-decode risk for integrators).
- 2026-10-04 · `/api/v1/pub/context` vs mainnet · expected perpIds to match across networks · actual: testnet BTC 16 / ETH 32 / SOL 48 / MON 64 / ZEC 256 / LIT 272 / PUMP 320 / NEAR 336, mainnet BTC 1 / MON 10 / ETH 20 / SOL 31 · severity: low, but easy to hardcode wrongly.
- 2026-10-04 · Exchange struct field `ignOracle` · undocumented in the README; matters to anyone reading oraclePNS as a price. Receipts asserts it is false at commit.

- 2026-10-04 · Exchange.getPerpetualInfo(unknown id): reverts `ContractDoesNotExist(uint256)` (selector 0x4c9f9b4a); verified for ids 0 and 999 on testnet. Good behaviour (no silent zero struct); not documented in the README. Receipts relies on it (attack A8).
