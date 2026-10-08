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

// Real-world naming variants across providers must still match (no false rejections).
const accept = [
  ["FC Bayern München", "Bayer 04 Leverkusen", "Bayern Munich", "Bayer Leverkusen"],
  ["Borussia Mönchengladbach", "1. FC Köln", "Borussia Monchengladbach", "FC Cologne"],
  ["Sport Lisboa e Benfica", "Sporting Clube de Portugal", "Benfica", "Sporting CP"],
  ["Mirassol FC", "EC Vitória", "Mirassol", "Vitoria BA"],
  ["Manchester United FC", "Newcastle United FC", "Man United", "Newcastle"],
  ["Wolverhampton Wanderers FC", "Brighton & Hove Albion FC", "Wolverhampton Wanderers", "Brighton and Hove Albion"],
  ["Paris Saint-Germain FC", "Olympique de Marseille", "PSG", "Olympique Marseille"],
  ["Club Atlético de Madrid", "Athletic Club", "Atletico Madrid", "Athletic Bilbao"],
  ["FC Internazionale Milano", "AC Milan", "Inter Milan", "AC Milan"]
];
for (const [h, a, eh, ea] of accept) {
  const event = ev(eh, ea);
  assert.equal(matchOddsEvent(fx(h, a), [event]).event, event, `${h}-${a} should match ${eh}-${ea}`);
}

// Swapped home/away, sister clubs, women's/reserve/youth sides must never match.
const reject = [
  ["Leeds United FC", "West Ham United FC", "West Ham United", "Leeds United"],
  ["Manchester United FC", "Manchester City FC", "Manchester City", "Manchester United"],
  ["Real Madrid CF", "Real Sociedad", "Real Madrid", "Real Betis"],
  ["Sheffield United", "Leeds United", "Sheffield Wednesday", "Leeds United"],
  ["Inter", "Milan", "AC Milan", "Inter"],
  ["Atlético Madrid", "Athletic Club", "Atletico Madrid", "Atletico Mineiro"],
  ["Arsenal", "Chelsea", "Arsenal Women", "Chelsea Women"],
  ["Arsenal", "Chelsea", "Arsenal", "Chelsea W"],
  ["Barcelona", "Girona", "Barcelona B", "Girona"],
  ["Bayern München", "Bayer Leverkusen", "Bayern Munich II", "Bayer Leverkusen"],
  ["Borussia Dortmund", "Borussia Mönchengladbach", "Borussia Monchengladbach", "Borussia Dortmund"]
];
for (const [h, a, eh, ea] of reject) {
  assert.equal(matchOddsEvent(fx(h, a), [ev(eh, ea)]).event, null, `${h}-${a} must not match ${eh}-${ea}`);
}

// Kickoff window: +-3h accepted, beyond rejected; closest kickoff wins between duplicates.
const at = hours => new Date(Date.parse(t) + hours * 3600_000).toISOString();
const timed = hours => ({ home_team: "Leeds United", away_team: "West Ham United", commence_time: at(hours) });
const fixture = fx("Leeds United", "West Ham United");
assert.ok(matchOddsEvent(fixture, [timed(2.9)]).event);
assert.equal(matchOddsEvent(fixture, [timed(3.1)]).event, null);
assert.equal(matchOddsEvent(fixture, [timed(24)]).event, null);
const near = timed(0);
assert.equal(matchOddsEvent(fixture, [timed(2), near]).event, near);

console.log("Stage 18 tests OK: token-based odds event matching rejects false positives.");
