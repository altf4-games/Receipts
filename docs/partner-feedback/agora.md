# Partner feedback: agora

Written as friction happens. Format: date · doc/endpoint · expected · actual (exact error text) · workaround · severity.


- 2026-10-04 · docs.agora.finance/developer/contract-deployments · expected the testnet faucet function to be documented next to its address · actual: only the address is listed; the contract is an unverified ERC-1967 proxy, so a bytecode selector scan finds proxy-shell selectors that resolve to nothing (0x661013d5, 0x68280378, 0xd91f2706) · workaround: read the EIP-1967 slot, then scan the implementation: `requestFunds(address)`, plus views `faucetDripAmount`, `maxDripFrequency`, `maxAmountToOwn` · severity: medium (cost ~20 min). Fix: verify the implementation on Sourcify and document `requestFunds`.

- 2026-10-04 · AUSD testnet token + Foundry `deal`: `deal(AUSD, user, amt)` fails with "stdStorage checked_write(StdStorage): Failed to write value" (balance slot not discoverable behind the proxy layout). Workaround: fund test accounts via the real faucet `requestFunds(address)`. severity: low.
- 2026-10-05 · faucet 0xd236... requestFunds · expected a per-address cooldown · actual: one request per 60 s GLOBALLY across all callers (custom error MaxFrequencyExceeded() 0x20e5bc67); on a forked block any other developer's request just before it makes a test revert. Workaround: warp 61 s for the faucet call. Suggest per-address limits.
