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

## Run 2026-11-09
Baseline: `npm test` green (needs `npm ci` in fresh cloud checkout).

### Audited (no defect found)
- `challenger/poisson.js`: matrix/outcomes sum to 1 (renormalised truncation at 8 goals; tail ≤0.4% at λ=3.2). `removeMargin` proportional, correct. `classify.js` edge/EV/fairOdds formulas consistent. `teamStrength.js` attack/defence ratios use correct league baselines. Match feed is `status=FINISHED` only, so null scores are not counted as 0-0.
- No totals / Asian / BTTS model exists in `src` (1X2 only) — those items cannot be audited.

### Fixed
- `bestH2H` accepted any truthy price, so a malformed price (≤1, NaN, string) from a provider could be chosen (highest odds sum) and feed removeMargin/EV. Now rows with any non-numeric or ≤1 price are skipped (data validation only; no thresholds/math touched). Test: `tests/stage19.test.js` (+ Poisson invariants).

### Open
- Same as previous run (legacy `src/bot.js` matcher; `bestH2H` single-row selection is protected logic → owner decision).
- Football-data previous-season fallback mixes old-season match rates with current standings (`providers/footballData.js:78-90`) — evaluate impact on early-season λ.
- Not auditable without runtime `data/`: Mirassol–Vitória stored signal, ROI/calibration on history.

### Next
Audit `historical/featureSnapshot.js` temporal safety, `risk/riskScore.js`, `quality/dataQuality.js`; Telegram market labels.
