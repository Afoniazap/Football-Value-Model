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

## Run 2026-10-12
Baseline: `npm test` green (after `npm ci`).

### Fixed (confirmed)
- `poisson.js`: negative/NaN/Infinity lambda silently produced negative or NaN probabilities (e.g. lambda=-1 -> home=-0.32). Now throws RangeError. Production path unaffected (lambdas clamped 0.25..3.2/0.2..2.8, form factor ±8%).
- `calibration.js`: `fitTemperature([])` returned T=0.75 (sharpening with zero evidence, logLoss null). Now identity (T=1).
- Tests: `tests/stage19.test.js` (sum=1, symmetry, monotonicity, truncation tail <1% at max clamp, invalid lambda, empty calibration). No production math/thresholds touched.

### Audited, no defect
- Temporal safety in `featureSnapshot.js` (strict `<` kickoff, leakage assert, covered by stage3). Live context uses FINISHED matches only.
- Challenger Poisson: score matrix truncation at 8 goals renormalized; bias ≤0.6% mass at the clamp maximum (documented, left as is).

### Open
- Same as previous run (legacy `src/bot.js` duplicates; `bestH2H` single-bookmaker row = owner decision).
- Not yet audited: production `buildModel` softmax calibration (protected), DQ/SCI/MAI/FDS, Asian totals/BTTS, ROI/calibration on history (no `data/` in cloud), Telegram market display.

### Next
1. Audit `src/quality/*` and `src/risk/*` scoring ranges/monotonicity; decision classification boundaries (VALUE/NEAR/WAIT/NO_BET) with boundary tests.
2. Verify `src/bot.js` is dead code.

### Next (previous run)
1. Audit `src/model/challenger/*` (Poisson, calibration) with property tests (probabilities sum to 1, monotonicity, truncation at maxGoals=8).
2. Audit risk/quality scores and temporal safety in `historical/featureSnapshot.js`.
