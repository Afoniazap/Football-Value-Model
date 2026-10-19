# FVM Cloud Progress

## Run 2026-10-08
Baseline: `npm test` green (stages parity..17) before changes.

### Fixed (confirmed)
- **False-positive odds event matching** (`src/market/oddsMatching.js`). Name similarity used character-set overlap, so unrelated pairs matched and could attach foreign odds to a fixture:
  Real Madrid–Valencia ↔ Real Sociedad–Villarreal (0.84), Inter–Roma ↔ Internacional–Atletico Mineiro (0.71), Mirassol–Vitória ↔ Vitória Guimarães–Mirassol (0.72).
  Now token-based (diacritics stripped, club aliases, fuzzy token ≥0.8 for tokens ≥5 chars), and each side must score ≥0.4. All three cases now give NO_MATCH; diacritic/suffix/alias variants still match.
  Test: `tests/stage18.test.js` (added to `npm test`). No thresholds/model math touched.

- Final audit of the matcher (39 real-world pairs, swap/alias/qualifier/time): fixed false *rejections* (Bayern München↔Munich, Köln↔Cologne, Sporting CP, Vitória BA) via noise tokens + synonyms, and false matches of women's/reserve/youth sides (Chelsea Women, Barcelona B). Kickoff window ±3h verified.
- Residual risk closed: containment now requires generic suffix words (united/city/…) or a confirmed alias; "Santos" vs "Santos Laguna", "Newcastle" vs "Newcastle Jets" etc. are rejected. sport_key/country/league mismatch rejects; odds-api.io matcher now shares the same similarity and rejects league mismatch. Trade-off: unlisted long forms (e.g. "Frankfurt" vs "Eintracht Frankfurt") are rejected until added to CLUB_ALIASES (fail-safe).

### Open / not yet addressed
- `src/bot.js` contains a legacy duplicate `similarity`/`findOddsEvent`/`bestH2H` (char-overlap > 0.58, no kickoff check). Not the `npm start` entry (`src/app.js`); verify it is dead code, then remove or reuse shared matcher.
- `bestH2H` picks the single bookmaker row with highest odds sum (not best price per outcome); marked TODO in code. Protected logic (edge/EV inputs) — needs owner decision.
- Not yet audited: Poisson/Asian totals/BTTS, DQ/SCI/MAI/FDS, calibration/ROI on history, Telegram market display, Mirassol–Vitória anomaly in stored signals (no runtime `data/` in cloud checkout).

## Run 2026-10-19
Baseline: `npm ci && npm test` green (stages parity..18).

### Verified correct (no change needed) — tests in `tests/stage19.test.js`
- Challenger Poisson (`src/model/challenger/poisson.js`): 1X2 sums to 1, score matrix mass 1, monotone in lambdas, draw > 5% across clamp range, maxGoals=8 truncation loss <0.1% at lambda 1.4.
- Settlement quarter-line grading (Over/Under, Asian handicap, HALF_WIN/HALF_LOSS) and half-win/loss accounting are correct.
- Temporal safety in `createPreMatchContext` (strict `< kickoff`) is correct.

### CONFIRMED ANOMALY — APPROVAL REQUIRED (protected production logic, NOT changed)
`src/model/probability.js` (`buildModel`, production 1X2) is overconfident. Softmax over `strength = 0.65*dPPG + 0.22*dGD + 0.75*dForm` with draw logit `0.05 - 0.28*|strength|`:
- ppg 2.6/gd +1.8/form 100% vs ppg 0.6/gd -1.2/form 0%: H 0.973 / D 0.024 / A 0.003.
- ppg 2.8 vs 0.4: H 0.986 / D 0.013 / A 0.001.
- ppg 2.0 vs 1.0: H 0.800 / D 0.142 / A 0.058.
Real football draw rate rarely falls below ~10%; probabilities >0.95 inflate edge/EV and can fabricate VALUE (likely source of the Mirassol–Vitória style anomalies). Reproduction script: sweep over `buildModel` with synthetic standings.
Recommendation: owner-approved shadow evaluation of a bounded model (draw floor / probability cap, or shrinkage toward the challenger Poisson) with calibration + log-loss comparison on real history before any production change. Thresholds untouched.

### Open / not yet addressed
- `src/bot.js` legacy duplicate matcher (see 2026-10-08) — verify dead code.
- `bestH2H` picks single bookmaker row with highest odds sum (protected edge/EV input; needs owner decision).
- `leagueGoalRates`/`recentForm` coerce missing scores to 0 (`|| 0`); safe only while contexts contain FINISHED matches (football-data provider filters FINISHED) — add guard test.
- Not auditable without runtime `data/`: stored-signal calibration/ROI, Mirassol–Vitória stored signal, Telegram display, DQ/SCI/MAI/FDS scoring (not yet read).

### Next
1. Audit `src/quality/dataQuality.js`, `src/risk/*`, `src/decision/classify.js` for score ranges and classification consistency.
2. Prepare shadow-comparison script (production vs challenger calibration) on backtest fixtures for the owner decision above.
