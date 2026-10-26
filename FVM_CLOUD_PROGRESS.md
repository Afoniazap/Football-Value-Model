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

## Run 2026-10-26
Baseline: PR #1 merged; branch restarted from `main`. `npm ci` required first (fresh checkout lacked `dotenv`); then `npm test` green.

### Verified (no defect found)
- Challenger Poisson (`poisson.js`): outcome probs sum to 1 across the full clamp range (λh 0.25–3.2, λa 0.2–2.8), symmetric, monotone. Truncation at 8 goals drops 0.57% single-side mass at λ=3.2 (renormalised; ~1% worst case joint) — minor, left unchanged (math change).
- `removeMargin` (proportional), `applyTemperature` (T=1 identity, T>1 flattens), `expectedGoalsFromContext` (attack/defence ratios consistent; empty context gives bounded finite λ).
- `classify` edge = p − no-vig p, EV = p·odds − 1, fair odds = 1/p: formulas correct.
- Test added: `tests/stage19.test.js` (in `npm test`). No production math/thresholds changed.

### Open (carried over + new)
- `src/bot.js` is dead (not referenced by `src/app.js`, scripts, tests) and keeps the old char-overlap matcher. Deletion left for owner decision.
- `bestH2H` still picks a single bookmaker by odds sum (protected edge/EV input; owner decision).
- `buildModel`/`recentForm` use `Number(x) || 0`: a null score would count as 0–0. Currently safe because football-data fetch is `status=FINISHED`; consider an explicit guard.
- Still unaudited: DQ/SCI/MAI/FDS (`quality/`, `risk/riskScore.js`), asian totals/BTTS (no implementation found in `src/model`), settlement, temporal safety in `historical/featureSnapshot.js`, Telegram display, calibration/ROI on real history (no `data/` in cloud).

### Next
1. Audit `risk/riskScore.js` + `quality/dataQuality.js` and `historical/featureSnapshot.js` temporal safety.
2. Audit `audit/settlement.js` totals/BTTS grading.
