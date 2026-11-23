# FVM Cloud Progress

## Run 2026-11-23
Baseline: `npm test` green (stages parity..18). Branch restarted from main 478dcfe (PR #1 merged).

### Fixed (confirmed, diagnostics-only — no model/edge/EV/threshold change)
- **MARKET_DISAGREEMENT fired on almost every multi-book market** (`src/risk/riskScore.js` `marketSpread`). All outcomes of all books were flattened, so favourite (1.50) vs underdog (6.50) price counted as bookmaker disagreement (>1.5). Now spread = max over outcomes of (max−min price for the SAME outcome, matched by name, so outcome order doesn't matter). Threshold 1.5 unchanged.
  Synthetic 2000 markets, 3 books, ±2% noise: flagged 1637 → 0. Real 1.8 gap on one outcome still flagged.
- **Model Agreement was sign-blind** (`modelAgreement`). `abs(strength)` vs `abs(form)` meant strength favouring home + form favouring away scored as *agreement* (repro: opposite = 66/100, same direction = 43/100). Now signed difference; opposite directions → 0/100.
  Synthetic: 352 clear opposite-direction cases, 253 passed as agreement ≥70 before → 0 after. MODEL_DISAGREEMENT flag rate 764 → 1194 /2000.
  Impact: Risk score, HIGH_RISK blocker, decisionConfidenceV2, UI. Not part of VALUE gating (`classify` + shadow gate use `item.confidence`).
- Removed dead legacy `src/bot.js` (not imported anywhere, not an npm script; contained old char-overlap matcher).
- Test: `tests/stage19.test.js` (spread, agreement, Poisson sum/symmetry/monotonicity/reference P(draw|1,1)=0.3085, margin removal).

### Observations (not changed)
- Challenger Poisson `maxGoals=8`: tail mass at λ=3.2 is 0.57% (renormalized). Shadow-only; ≤~0.5pp bias in extreme favourites. Could raise to 10 if challenger ever goes to production.
- Model-agreement scale: compares magnitude of table-strength part vs form part (different scales: ppg/gd vs form fraction). Even same-direction cases often score <70. Recalibrating weights = risk-threshold semantics → owner decision.
- Live context season fallback: if current season has no FINISHED matches, previous-season matches are used for form/league rates while standings are current (playedGames≈0). Production model then relies on form only; DQ reflects it. Worth an explicit flag.
- `npm run doctor` cannot run in cloud (no `.env`, ALLOWED_CHAT_IDS) — external limitation.

### Next
1. Audit `classify` confidence formula + shadow gate on stored history (needs runtime `data/`; unavailable in cloud).
2. DQ `homeAwaySplits` always PARTIAL 8/15 even when live HOME/AWAY splits are built by `createLivePreMatchContext` — verify and fix label/score.
3. Asian totals / BTTS: not implemented in model (only 1X2 + expectedGoals) — confirm Telegram doesn't display such markets.

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
- [DONE 2026-11-23: removed] `src/bot.js` contains a legacy duplicate `similarity`/`findOddsEvent`/`bestH2H` (char-overlap > 0.58, no kickoff check). Not the `npm start` entry (`src/app.js`); verify it is dead code, then remove or reuse shared matcher.
- `bestH2H` picks the single bookmaker row with highest odds sum (not best price per outcome); marked TODO in code. Protected logic (edge/EV inputs) — needs owner decision.
- Not yet audited: Poisson/Asian totals/BTTS, DQ/SCI/MAI/FDS, calibration/ROI on history, Telegram market display, Mirassol–Vitória anomaly in stored signals (no runtime `data/` in cloud checkout).

### Next
1. Audit `src/model/challenger/*` (Poisson, calibration) with property tests (probabilities sum to 1, monotonicity, truncation at maxGoals=8).
2. Audit risk/quality scores and temporal safety in `historical/featureSnapshot.js`.
