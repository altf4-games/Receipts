# Open rankers

Ranking algorithms for curators, as **pure TypeScript functions**: same input, same output, no clock, no randomness, no network. Each one is registered on chain in `RankerRegistry` with its author, code location and the git commit it was published at, so a feed can say "ranked by `luck-adjusted` at commit `abc123`" and anyone can rerun that exact code over the indexer's public data.

| Ranker | Score | Notes |
|---|---|---|
| `raw` | sum of closed-call scores (bps) | simple; rewards volume and luck. An unrevealed call counts -3000, so hiding is never free |
| `mean-per-call` | average score per closed call | fair across volumes, fooled by a short hot streak |
| `luck-adjusted` | lower 95% bound of the mean: `mean - 1.645 * sd / sqrt(n)` (sd floored at 10 bps), needs 10 closed calls | a short lucky streak ranks below a long solid record |
| `hit-rate-wilson` | Wilson lower bound of the share of calls above zero, needs 10 closed calls | expired and invalid calls are losses |

## The coin-flip illustration (a simulation, not data)

`pnpm exec tsx scripts/coinflip.ts` runs a seeded simulation: 30 pure coin flippers with 10-120 calls each and 3 curators with a real edge, 1,000 trials.

| Scenario | rule | #1 is a skilled curator | skilled curators in the top 3 |
|---|---|---|---|
| weak edge (58% wins, 60 calls) | raw | 40.7% | 1.01 of 3 |
| | mean-per-call | 33.8% | 0.94 of 3 |
| | **luck-adjusted** | **46.9%** | **1.13 of 3** |
| clear edge (65% wins, 100 calls) | raw | 99.0% | 2.68 of 3 |
| | mean-per-call | 65.5% | 1.92 of 3 |
| | luck-adjusted | 92.6% | 2.44 of 3 |

What this shows, honestly: the luck-adjusted rule beats the average per call in both cases and beats raw when the edge is weak and volumes differ, but **raw is better when the edge is large and volumes are alike**. The bound is conservative: it needs about 100 calls to separate a small edge (+16 bps per call) from luck, and with fewer calls no rule can. Its job is to stop rewarding short streaks and volume, not to find skill faster.

```bash
pnpm install && pnpm test    # 14 tests: arithmetic, ordering, determinism, the simulation direction checks
```
