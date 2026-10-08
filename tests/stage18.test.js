import assert from "node:assert/strict";
import { matchOddsApiIoEvent } from "../src/providers/market/oddsApiIo.js";
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

// Partial-name containment is never identity: short names must not match different clubs.
const ambiguous = [
  ["Santos", "Vasco da Gama", "Santos Laguna", "Vasco da Gama"],
  ["Newcastle United", "Everton", "Newcastle Jets", "Everton"],
  ["Atlético", "Palmeiras", "Atletico Mineiro", "Palmeiras"],
  ["Real Madrid", "Valencia", "Real Madrid Castilla", "Valencia"],
  ["Independiente", "Boca Juniors", "Independiente del Valle", "Boca Juniors"],
  ["Nacional", "Peñarol", "Atlético Nacional", "Peñarol"],
  ["Dynamo Kyiv", "Shakhtar Donetsk", "Dynamo Moscow", "Shakhtar Donetsk"],
  ["Spartak Moscow", "Zenit", "Spartak Trnava", "Zenit"],
  ["River Plate", "Boca Juniors", "River Plate Montevideo", "Boca Juniors"],
  ["Sporting CP", "Braga", "Sporting Gijon", "Braga"],
  ["Lyon", "Lille", "Lyon La Duchere", "Lille"],
  ["Real", "Valencia", "Real Madrid", "Valencia"],
  ["Manchester", "Arsenal", "Manchester United", "Arsenal"],
  ["Manchester", "Arsenal", "Manchester City", "Arsenal"],
  ["Sheffield", "Leeds United", "Sheffield United", "Leeds United"],
  ["Nottingham", "Leeds United", "Nottingham Forest", "Leeds United"]
];
for (const [h, a, eh, ea] of ambiguous) {
  assert.equal(matchOddsEvent(fx(h, a), [ev(eh, ea)]).event, null, `${h}-${a} must not match ${eh}-${ea}`);
}

// Confirmed aliases and generic-suffix long forms still match.
const confirmed = [
  ["Newcastle", "Everton", "Newcastle United", "Everton"],
  ["Leeds", "West Ham", "Leeds United", "West Ham United"],
  ["Wolves", "Brighton", "Wolverhampton Wanderers", "Brighton and Hove Albion"],
  ["Real Betis Balompié", "RCD Espanyol de Barcelona", "Real Betis", "Espanyol"],
  ["Athletic Club", "Real Sociedad de Fútbol", "Athletic Bilbao", "Real Sociedad"],
  ["Sport Lisboa e Benfica", "Gil Vicente", "Benfica", "Gil Vicente FC"],
  ["Vitória", "Cruzeiro", "Vitoria BA", "Cruzeiro MG"]
];
for (const [h, a, eh, ea] of confirmed) {
  const event = ev(eh, ea);
  assert.equal(matchOddsEvent(fx(h, a), [event]).event, event, `${h}-${a} should match ${eh}-${ea}`);
}

// League/country context: a different competition or country is never the same fixture.
const withSport = (sport_key) => ({ ...ev("Arsenal", "Chelsea"), sport_key });
assert.ok(matchOddsEvent({ ...fx("Arsenal", "Chelsea"), sportKey: "soccer_epl" }, [withSport("soccer_epl")]).event);
assert.equal(matchOddsEvent({ ...fx("Arsenal", "Chelsea"), sportKey: "soccer_epl" }, [withSport("soccer_fa_cup")]).event, null);
assert.equal(matchOddsEvent({ ...fx("Santos", "Vasco"), country: "Brazil" }, [{ ...ev("Santos", "Vasco"), country: "Mexico" }]).event, null);
assert.ok(matchOddsEvent({ ...fx("Santos", "Vasco"), country: "Brazil" }, [{ ...ev("Santos", "Vasco"), country: "Brazil" }]).event);

// odds-api.io matcher shares the same strict identity rules and rejects other leagues.
const io = (home, away, slug = "england-premier-league") => ({ home, away, date: t, league: { slug } });
const ioFixture = (home, away) => ({ home, away, utcDate: t, competitionCode: "PL" });
const ioOk = io("Newcastle United", "Everton");
assert.equal(matchOddsApiIoEvent(ioFixture("Newcastle", "Everton"), [ioOk]).event, ioOk);
assert.equal(matchOddsApiIoEvent(ioFixture("Newcastle United", "Everton"), [io("Newcastle Jets", "Everton")]).event, null);
assert.equal(matchOddsApiIoEvent(ioFixture("Real Madrid", "Valencia"), [io("Real Sociedad", "Villarreal")]).event, null);
assert.equal(matchOddsApiIoEvent(ioFixture("Newcastle United", "Everton"), [io("Newcastle United", "Everton", "england-fa-cup")]).event, null);

console.log("Stage 18 tests OK: token-based odds event matching rejects false positives.");
