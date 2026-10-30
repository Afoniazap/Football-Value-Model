# ratings-v1 (Shadow-only research module)

**Status: NOT applied to Termux.** This branch is based on `termux-v0.5 @ e7e133c` and adds files only; it changes no existing file,
no production logic, no VALUE threshold, no Telegram text and no stored statistics. Do not merge into `termux-v0.5` without a separate decision.

## What is added
| Path | Purpose |
|---|---|
| `src/shadow/ratings/ratingsCore.js` | pure model (no I/O, clock, randomness, env): opponent-adjusted Poisson/Dixon-Coles ratings + goal-difference Elo, season carry-over, `runChronological`, `buildStateAsOf` |
| `src/shadow/ratings/ratingsParams.js` | frozen hyper-parameters + stable `paramsId` (a change = new version) |
| `src/shadow/ratings/ratingsShadow.js` | adapter: history rows -> matches, one prediction record, append-only idempotent writer (own file only) |
| `scripts/ratings-v1-backtest.js` | chronological backtest on a read-only copy of `football.sqlite` |
| `scripts/ratings-v1-tune.js` | parameter search on a TRAINING window only |
| `test/ratingsV1.test.js` | 11 tests: validity, determinism and input-order independence, no look-ahead, information lag, purity, season carry, frozen parameters, isolation, idempotent writer |
| `research/ratings-v1/` | comparison script, aggregated results, tuning output, isolation verifier, report |

## Safe way to try it on Termux on top of uncommitted changes (nothing here touches existing files)
```
git fetch origin claude/termux-ratings-v1
git diff e7e133c origin/claude/termux-ratings-v1 -- src/shadow/ratings scripts/ratings-v1-backtest.js scripts/ratings-v1-tune.js test/ratingsV1.test.js > /tmp/ratings-v1.diff
git apply --check /tmp/ratings-v1.diff && git apply /tmp/ratings-v1.diff     # only adds new files; atomic
node --test test/ratingsV1.test.js
node scripts/ratings-v1-backtest.js --db data/history/football.sqlite.copy --out /tmp/rv1.jsonl --lag 12 --params v1 --from 2026-08-01   # use a COPY of the database
```
Rollback: delete the added files (`git apply -R /tmp/ratings-v1.diff`). No existing file is edited, so uncommitted Termux changes stay intact.

Wiring into the live cycle is intentionally NOT included. When approved it is one guarded call after `buildDualShadow` in `src/app.js`
(`try { appendRatingsPredictions(RATINGS_FILE, [buildRatingsPrediction({fixture, matches, now})]) } catch {}`) writing to its own file under `data/statistics/`.

## Rules the module is built around
1. Information time: a match is usable only after `kickoff + 180 min` and only if that moment is not later than the prediction cutoff (`kickoff_target - lagHours`; evaluation uses 12 h, live predictions use "now").
2. Parameters are fixed before the period they are evaluated on; `carry` is a prior (not tunable with one season of data).
3. Same inputs -> byte-identical outputs (`stateHash` = FNV over applied match ids; backtest output compared with `cmp`).
