# Partner feedback: monad

Written as friction happens. Format: date · doc/endpoint · expected · actual (exact error text) · workaround · severity.


- 2026-10-04 · Foundry install: `cast wallet new --json` output shape changed in cast 1.8.4 (`{schema_version, success, data, errors, warnings}`, key material under `data`); older scripts parsing a top-level list break and (if unchecked) can write empty keys to a file. Mine failed safe (length check) · severity: low.

- 2026-10-04 · Foundry 1.8.4 fork tests on Monad: `vm.createSelectFork` fails with "cannot create a `monad` fork with an EVM instantiated for `ethereum`; run the script with --rpc-url pointing to the forked chain" unless the test run itself is started with `--fork-url <monad rpc>`. Not mentioned in the Monad Foundry guide. Workaround: always `forge test --fork-url $MONAD_TESTNET_RPC`. severity: low-medium (confusing, error text is accurate once you know).
- 2026-10-04 · Foundry scripts: `vm.writeJson` to a path outside the project is refused until `fs_permissions` is set in foundry.toml. Standard Foundry behaviour, noting for the deploy guide.

- 2026-10-04 · Receipts: `gasUsed` in Monad receipts equals the gas LIMIT, not the amount executed (measured: limit 46,169 -> gasUsed 46,169, fee paid == limit x effectiveGasPrice; faucet call limit 200,000 -> gasUsed 200,000 while estimateGas said 130,600). Matches the docs' "charged on gas_limit" but means receipts cannot tell integrators actual consumption; size limits from eth_estimateGas (+~20%). severity: informational, but easy to miss when benchmarking.
- 2026-10-04 · Block-granularity: a Perpl oracle update can land in the same block as a user tx. `eth_call` at block B returns post-block state, so an independent check of "the price my tx saw" must accept the oracle at B-1 or B. Receipts' live tests do exactly that and log which matched (B-1 in run 1).

- 2026-10-04 · Cloudflare Workers (not Monad, tooling note for the Monad build): (a) cron triggers cannot be scheduled until the account has a workers.dev subdomain (API code 10063) and wrangler only offers to create one when `workers_dev = true`; (b) Workers Free allows 50 subrequests/invocation and each viem tx costs ~8 RPC calls (estimateGas, nonce, fee, chainId, send, receipt polls), so a tick that sends >4 txs fails with an opaque "HTTP request failed."; (c) wrangler >= 4.14x requires Node 22, pin 4.86.0 for Node 20; (d) `wrangler tail --format json` emits pretty-printed multi-line objects, not JSON lines.
- 2026-10-04 · Cloudflare Workers: a Worker deployed with `workers_dev = false`, no routes and a cron trigger printed "schedule: * * * * *" on deploy but its cron NEVER fired (13+ min, two separate tail sessions saw nothing). Re-deploying the same Worker with `workers_dev = true` made the cron fire on the next minute. No warning from wrangler either way. Cost me ~15 min of production bot coverage on the Worker side (the Mac runner covered it).
- 2026-10-05 · Cloudflare Workers: `outcome=exception` on scheduled runs with 2 ms CPU, empty `exceptions` and no logs gives no diagnostic at all, so a failure is invisible unless the handler itself catches and logs. Also `wrangler dev` (4.86.0) cannot run a Worker whose compatibility_date is newer than the bundled workerd supports (no fallback, just a startup error).

## 2026-10-05: transient public-RPC error on eth_call
Once, a page's batch of 4 eth_calls via the public RPC failed with 'Missing or invalid parameters. Double check you have provided the correct parameters.' although the same calls succeeded seconds later (same params). Looks like a transient/rate-limit style error with a misleading message. The UI surfaces it and a reload recovers.

## 2026-10-05: Monad wording for out-of-gas wallets
A wallet with no MON calling the AUSD faucet gets: "RPC 0x279f Custom eth_sendRawTransaction: Signer had insufficient balance" (not the usual "insufficient funds for gas"). Wallet UIs and error mappers keyed on the Ethereum wording miss it; the app now maps both.
