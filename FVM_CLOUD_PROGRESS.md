# FVM Cloud Progress

## Run 2026-11-16
Baseline: branch == main (478dcfe, PR #1 merged); `npm test` green.

### Fixed (confirmed)
- **Extra-time / penalty scores used as 90-minute results.** football-data v4 `score.fullTime` is the aggregate incl. extra time and shoot-out goals (docs example: fullTime 7-6, regularTime 1-1, duration PENALTY_SHOOTOUT). FVM read `fullTime` everywhere, so for CL/EL/CLI knockouts:
  - settlement graded 1X2/totals/AH on the wrong score (a 1-1 draw decided on penalties settled X as LOSS, Under 2.5 as LOSS);
  - model context (league goal rates, team splits, form, Elo) and historical backtest data were inflated by ET/penalty goals.
  New `src/providers/footballDataScore.js` (`regulationScore`, `toRegulationMatches`) uses `regularTime` when `duration` is EXTRA_TIME/PENALTY_SHOOTOUT; if `regularTime` is missing the match is unsettled/dropped (never guessed). Applied in `footballDataResults` (settlement input), `fetchCompetitionContext` (model context, meta `extraTimeAdjusted`/`unknownRegulationDropped`), `historical/normalize`. Regular-duration matches unchanged → parity unchanged.
- **Missing goals settled as 0-0.** `Number(null) === 0` passed the finite check: `settleSignal` with null goals graded X/Under as WIN, and an UNSETTLED row could be persisted permanently (idempotency blocks re-settlement). `settleSignal` now returns null for missing goals; `settleOfficialSignal` never persists UNSETTLED.
- Test: `tests/stage19.test.js` (before/after: league home goals/game 4.00 → 1.67 on the shoot-out sample; X and Under 2.5 on a 1-1 shoot-out now WIN).

### Limitations
- `npm run doctor` cannot run in cloud (no `.env`; ALLOWED_CHAT_IDS required). No live smoke test (no API keys / runtime `data/`), so already-stored settlements of ET matches cannot be checked here — owner should review settlements of knockout fixtures (not rewritten automatically: audit history is append-only).


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

### Next (carried over)
1. Audit `src/model/challenger/*` (Poisson, calibration) with property tests (probabilities sum to 1, monotonicity, truncation at maxGoals=8).
2. Audit risk/quality scores and temporal safety in `historical/featureSnapshot.js`.

## Priorities after 2026-11-16
1. Poisson/challenger property audit (sum=1, truncation maxGoals=8 renormalisation bias, clamp bounds 0.25–3.2 / 0.2–2.8), `leagueGoalRates` mixing previous-season matches with current-season standings in early season.
2. `src/bot.js` legacy matcher dead-code check (still open).
3. `bestH2H` single-bookmaker selection (owner decision; protected).
4. DQ/SCI/MAI/FDS/confidence audit; Telegram market display.
