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

### Next
1. Audit `src/model/challenger/*` (Poisson, calibration) with property tests (probabilities sum to 1, monotonicity, truncation at maxGoals=8).
2. Audit risk/quality scores and temporal safety in `historical/featureSnapshot.js`.

## Run 2026-11-02
Baseline: `npm test` green. Audited `src/model/challenger/*` (Poisson normalisation, temperature calibration, Elo, form): math correct (matrix renormalised, softmax stable, lambda clamps).

### Fixed (confirmed)
- **Score-less matches counted as 0:0** (`Number(null) || 0`). `leagueGoalRates`, challenger form/Elo and production `recentForm` could treat unplayed/in-play matches (null score) as goalless draws, deflating league averages and form, and satisfying the ≥3-games gate with phantom games. Repro: league rates 1.0/0.5 vs correct 2.0/1.0 when two null-score matches were present. Now only matches with a final score are used (`hasFinalScore`). Live context is FINISHED-only, so normal output is unchanged (full `npm test` identical); this is a guard against dirty/partial data. Test: `tests/stage19.test.js`. No thresholds/model formulas changed.

### Open
- Same as previous run (bot.js legacy matcher, `bestH2H` single-row pick — owner decision).
- Not yet audited: production `buildModel` uses current standings (not as-of fixture) — fine live, check backtest path; totals/BTTS/Asian lines, DQ/SCI/MAI/FDS, risk score, classify thresholds, calibration/ROI (no runtime `data/` in cloud checkout).

### Next
1. Audit `src/decision/classify.js`, `risk/riskScore.js`, `quality/dataQuality.js` and edge/EV math with property tests.
2. Audit totals/BTTS derivation from scoreMatrix.
