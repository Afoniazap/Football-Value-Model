import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clubNameSimilarity } from "../src/engine/clubMatching.js";
import { similarity } from "../src/engine/utils.js";
import { matchOddsEvent, matchOddsEventDetailed } from "../src/connectors/odds.js";
import { getOddsApiIoMarkets } from "../src/connectors/oddsApiIo.js";

const T = "2026-05-01T20:00:00Z";
const at = hours => new Date(Date.parse(T) + hours * 3600_000).toISOString();
const fx = (home, away, extra = {}) => ({ id: "f", home, away, utcDate: T, competitionCode: "PL", ...extra });
const ev = (home_team, away_team, extra = {}) => ({ home_team, away_team, commence_time: T, sport_key: "soccer_epl", ...extra });

const ACCEPT = [
  ["FC Bayern München", "Bayer 04 Leverkusen", "Bayern Munich", "Bayer Leverkusen"],
  ["Borussia Mönchengladbach", "1. FC Köln", "Borussia Monchengladbach", "FC Cologne"],
  ["Sport Lisboa e Benfica", "Sporting Clube de Portugal", "Benfica", "Sporting CP"],
  ["Mirassol FC", "EC Vitória", "Mirassol", "Vitoria BA"],
  ["Manchester United FC", "Newcastle United FC", "Man United", "Newcastle"],
  ["Wolverhampton Wanderers FC", "Brighton & Hove Albion FC", "Wolves", "Brighton and Hove Albion"],
  ["Paris Saint-Germain FC", "Olympique de Marseille", "PSG", "Olympique Marseille"],
  ["Club Atlético de Madrid", "Athletic Club", "Atletico Madrid", "Athletic Bilbao"],
  ["FC Internazionale Milano", "AC Milan", "Inter Milan", "AC Milan"],
  ["Real Betis Balompié", "RCD Espanyol de Barcelona", "Real Betis", "Espanyol"],
  ["Tottenham Hotspur FC", "Queens Park Rangers FC", "Tottenham", "Queens Park Rangers"],
  ["Newcastle", "Everton", "Newcastle United", "Everton"],
  ["Leeds", "West Ham", "Leeds United", "West Ham United"]
];

const REJECT = [
  // Swapped home/away
  ["Leeds United FC", "West Ham United FC", "West Ham United", "Leeds United"],
  ["Manchester United FC", "Manchester City FC", "Manchester City", "Manchester United"],
  // Sister clubs / shared prefixes
  ["Manchester United FC", "Newcastle United FC", "Manchester City", "Newcastle United"],
  ["Real Madrid CF", "Real Sociedad", "Real Madrid", "Real Betis"],
  ["Sheffield United", "Leeds United", "Sheffield Wednesday", "Leeds United"],
  ["Inter", "Milan", "AC Milan", "Inter"],
  ["Atlético Madrid", "Athletic Club", "Atletico Madrid", "Atletico Mineiro"],
  ["Borussia Dortmund", "Borussia Mönchengladbach", "Borussia Monchengladbach", "Borussia Dortmund"],
  // Partial-name containment
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
  ["Queens Park Rangers", "Middlesbrough", "Queens Park", "Middlesbrough"],
  // Bare city names shared by several clubs
  ["Manchester", "Arsenal", "Manchester United", "Arsenal"],
  ["Manchester", "Arsenal", "Manchester City", "Arsenal"],
  ["Sheffield", "Leeds United", "Sheffield United", "Leeds United"],
  // Women's / reserve / youth sides
  ["Arsenal", "Chelsea", "Arsenal Women", "Chelsea Women"],
  ["Arsenal", "Chelsea", "Arsenal", "Chelsea W"],
  ["Barcelona", "Girona", "Barcelona B", "Girona"],
  ["Bayern München", "Bayer Leverkusen", "Bayern Munich II", "Bayer Leverkusen"],
  ["Real Madrid", "Valencia", "Real Madrid U19", "Valencia"],
  ["Vitória SC", "Braga", "Vitória", "Braga"]
];

test("confirmed aliases and spelling variants still match", () => {
  for (const [h, a, eh, ea] of ACCEPT) {
    const event = ev(eh, ea);
    assert.equal(matchOddsEvent(fx(h, a), [event]), event, `${h}-${a} should match ${eh}-${ea}`);
  }
});

test("ambiguous, reversed, partial-name and non-first-team events are rejected", () => {
  for (const [h, a, eh, ea] of REJECT) {
    assert.equal(matchOddsEvent(fx(h, a), [ev(eh, ea)]), null, `${h}-${a} must not match ${eh}-${ea}`);
  }
});

test("similarity() no longer treats partial inclusion or bigram overlap as identity", () => {
  assert.equal(similarity("Santos", "Santos Laguna") < 0.7, true);
  assert.equal(similarity("Inter", "Internacional") < 0.7, true);
  assert.equal(similarity("Real Madrid", "Real Sociedad") < 0.7, true);
  assert.equal(similarity("Real Madrid CF", "Real Madrid"), 1);
  assert.equal(clubNameSimilarity("Newcastle", "Newcastle United"), 1);
});

test("The Odds API matcher enforces kickoff window and picks the closest kickoff", () => {
  const fixture = fx("Leeds United", "West Ham United");
  const timed = hours => ev("Leeds United", "West Ham United", { commence_time: at(hours) });
  assert.ok(matchOddsEvent(fixture, [timed(2.9)]));
  assert.equal(matchOddsEvent(fixture, [timed(3.1)]), null);
  assert.equal(matchOddsEvent(fixture, [timed(24)]), null);
  const near = timed(0.5);
  assert.equal(matchOddsEvent(fixture, [timed(2), near, timed(-2.5)]), near);
  assert.equal(matchOddsEventDetailed(fixture, [timed(2), near]).candidates, 2);
});

test("an event without kickoff time only matches identical/alias names", () => {
  const noTime = (h, a) => ({ home_team: h, away_team: a, sport_key: "soccer_epl" });
  assert.ok(matchOddsEvent(fx("Leeds United", "West Ham United"), [noTime("Leeds United FC", "West Ham United")]));
  assert.equal(matchOddsEvent(fx("Leeds United", "Everton"), [noTime("Leeds", "Everton")]) !== null, true);
  assert.equal(matchOddsEvent(fx("Newcastle", "Everton"), [noTime("Newcastle Jets", "Everton")]), null);
});

test("no correct match returns null and never falls back to the first event", () => {
  assert.equal(matchOddsEvent(fx("Arsenal", "Chelsea"), []), null);
  assert.equal(matchOddsEvent(fx("Arsenal", "Chelsea"), [ev("Liverpool", "Everton"), ev("Arsenal", "Chelsea Women")]), null);
});

test("another competition or country is never the same fixture", () => {
  assert.equal(matchOddsEvent(fx("Arsenal", "Chelsea"), [ev("Arsenal", "Chelsea", { sport_key: "soccer_fa_cup" })]), null);
  assert.ok(matchOddsEvent(fx("Arsenal", "Chelsea"), [ev("Arsenal", "Chelsea")]));
  assert.equal(matchOddsEvent(fx("Santos", "Vasco", { country: "Brazil", competitionCode: "BSA" }),
    [{ home_team: "Santos", away_team: "Vasco", commence_time: T, sport_key: "soccer_brazil_campeonato", country: "Mexico" }]), null);
});

function io(events) {
  const response = data => ({ ok: true, json: async () => data });
  return async url => response(url.pathname.endsWith("/events") ? events
    : events.map(event => ({ eventId: event.id, bookmakers: { b: [{ name: "1x2", odds: [{ home: 2, draw: 3, away: 4 }] }] } })));
}
async function ioMatch(fixture, events) {
  return getOddsApiIoMarkets({
    apiKey: "secret", fixtures: [fixture], request: io(events),
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "fvm-club-"))
  });
}
const ioEvent = (home, away, extra = {}) => ({ id: 1, home, away, date: T, ...extra });

test("odds-api.io matcher rejects partial names, other leagues, women's sides and wrong kickoff", async () => {
  assert.equal((await ioMatch(fx("Newcastle United", "Everton"), [ioEvent("Newcastle Jets", "Everton")])).matched, 0);
  assert.equal((await ioMatch(fx("Santos", "Vasco da Gama", { competitionCode: "BSA" }), [ioEvent("Santos Laguna", "Vasco da Gama")])).matched, 0);
  assert.equal((await ioMatch(fx("Arsenal", "Chelsea"), [ioEvent("Arsenal Women", "Chelsea Women")])).matched, 0);
  assert.equal((await ioMatch(fx("Arsenal", "Chelsea"), [{ ...ioEvent("Arsenal", "Chelsea"), date: at(5) }])).matched, 0);
  assert.equal((await ioMatch(fx("Arsenal", "Chelsea"), [ioEvent("Arsenal", "Chelsea", { league: { slug: "spain-laliga" } })])).matched, 0);
});

test("odds-api.io matcher keeps correct matches and picks the closest kickoff", async () => {
  const ok = await ioMatch(fx("Newcastle", "Everton"), [ioEvent("Newcastle United", "Everton", { league: { slug: "england-premier-league" } })]);
  assert.equal(ok.matched, 1);
  const duplicates = [ioEvent("Arsenal", "Chelsea", { id: 1, date: at(2) }), ioEvent("Arsenal", "Chelsea", { id: 2, date: at(0.25) })];
  const best = await ioMatch(fx("Arsenal", "Chelsea"), duplicates);
  assert.equal(best.byFixtureId.f.id, "2");
  const unknownSlug = await ioMatch(fx("Arsenal", "Chelsea"), [ioEvent("Arsenal", "Chelsea", { league: { slug: "some-provider-specific-slug" } })]);
  assert.equal(unknownSlug.matched, 1);
});
