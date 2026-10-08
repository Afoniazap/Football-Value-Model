import assert from "node:assert/strict";
import { matchOddsEvent } from "../src/market/oddsMatching.js";

const t = "2026-05-01T20:00:00Z";
const ev = (home_team, away_team) => ({ home_team, away_team, commence_time: t });
const fx = (home, away) => ({ home, away, utcDate: t });

// Unrelated clubs sharing letters/prefixes must never match.
assert.equal(matchOddsEvent(fx("Real Madrid", "Valencia"), [ev("Real Sociedad", "Villarreal")]).event, null);
assert.equal(matchOddsEvent(fx("Inter", "Roma"), [ev("Internacional", "Atletico Mineiro")]).event, null);
assert.equal(matchOddsEvent(fx("Mirassol", "Vitória"), [ev("Vitória Guimarães", "Mirassol")]).event, null);
assert.equal(matchOddsEvent(fx("Manchester City", "Arsenal"), [ev("Manchester United", "Aston Villa")]).event, null);

// Legitimate naming variants still match.
const diacritics = ev("Mirassol", "Vitoria");
assert.equal(matchOddsEvent(fx("Mirassol", "Vitória"), [diacritics]).event, diacritics);
const suffix = ev("Real Madrid CF", "Valencia CF");
assert.equal(matchOddsEvent(fx("Real Madrid", "Valencia"), [suffix]).event, suffix);
const alias = ev("Inter Milan", "AS Roma");
assert.equal(matchOddsEvent(fx("Inter", "AS Roma"), [alias]).event, alias);

console.log("Stage 18 tests OK: token-based odds event matching rejects false positives.");
