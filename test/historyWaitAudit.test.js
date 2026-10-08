import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameTeamIdentity } from "../src/history/teamAliases.js";
import { importHistoryMatches, openHistoryDatabase, getTeamLastMatches } from "../src/history/sqliteHistory.js";
import { buildLocalHistoryContext } from "../src/history/localHistory.js";
import { alignContextTeamIds } from "../src/engine/contextIds.js";
import { classifyTeamHistory, diagnoseFixtureHistory, findUnmatchedNameVariants } from "../src/history/historyDiagnostics.js";
import { explainModelShortfall } from "../src/history/contextProvenance.js";
import { cardText } from "../src/ui/telegram.js";

const KICKOFF = "2026-10-09T18:45:00Z";

function openDb() {
  return openHistoryDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-wait-")), "football.sqlite"));
}
let seq = 0;
function row({ home, away, day, hg = 1, ag = 0, source = "FOOTBALL_DATA", code = "DED", homeId = null, awayId = null }) {
  seq += 1;
  const playedAt = new Date(Date.parse("2026-08-01T18:00:00Z") + day * 86400_000).toISOString();
  return {
    recordKey: `${source}:${seq}`, sourceFixtureId: String(seq), playedAt, status: "FINISHED", sport: "FOOTBALL",
    competition: { code, name: code, season: "2026" },
    homeTeam: { id: homeId, name: home }, awayTeam: { id: awayId, name: away },
    score: { fullTime: { home: hg, away: ag } }, provenance: { source }, fetchedAt: "2026-10-01T00:00:00Z"
  };
}
// n games for `team` alternating venues against distinct opponents, stored under `spelling`.
function games(spelling, n, { startDay = 0, homeCount = null } = {}) {
  const homes = homeCount ?? Math.ceil(n / 2);
  return Array.from({ length: n }, (_, i) => row(i < homes
    ? { home: spelling, away: `Rival${i}x`, day: startDay + i }
    : { home: `Rival${i}x`, away: spelling, day: startDay + i }));
}

const FIXTURE = { id: "f", home: "PSV Eindhoven", away: "Heerenveen", homeId: 674, awayId: 675, utcDate: KICKOFF, competitionCode: "DED" };

test("confirmed alias gaps: provider spellings of the audited clubs are one identity", () => {
  for (const [a, b] of [
    ["PSV Eindhoven", "PSV"], ["Athletico Paranaense", "CA Paranaense"], ["Athletico Paranaense", "Club Athletico Paranaense"],
    ["Athletico Paranaense", "Athletico-PR"], ["Atlético-MG", "CA Mineiro"], ["Atlético-MG", "Atlético Mineiro"],
    ["Atlético-MG", "Clube Atlético Mineiro"], ["Criciúma", "Criciúma EC"], ["Náutico Recife", "Clube Náutico Capibaribe"],
    ["Náutico Recife", "Náutico"], ["Novorizontino", "Grêmio Novorizontino"], ["Ceará", "Ceará SC"], ["Heerenveen", "SC Heerenveen"]
  ]) assert.equal(sameTeamIdentity(a, b), true, `${a} == ${b}`);
});

test("new aliases do not merge different clubs", () => {
  for (const [a, b] of [
    ["Atlético-MG", "Atlético Madrid"], ["Atlético-MG", "Atlético Nacional"], ["Athletico Paranaense", "Atlético-MG"],
    ["Grêmio", "Grêmio Novorizontino"], ["Náutico", "Sport Recife"], ["PSV Eindhoven", "Eindhoven"], ["PSV", "Jong PSV"],
    ["Criciúma", "Cruzeiro"]
  ]) assert.equal(sameTeamIdentity(a, b), false, `${a} != ${b}`);
});

test("PSV stored under two spellings: history is no longer split (was 2 of 12)", () => {
  const db = openDb();
  importHistoryMatches(db, [...games("PSV", 10), ...games("PSV Eindhoven", 2, { startDay: 20 }), ...games("SC Heerenveen", 8)]);
  const found = getTeamLastMatches(db, { name: "PSV Eindhoven" }, KICKOFF, 20);
  assert.equal(found.length, 12);
  const context = buildLocalHistoryContext([
    ...found, ...getTeamLastMatches(db, { name: "Heerenveen" }, KICKOFF, 20)
  ], FIXTURE);
  assert.equal(context.contextMeta.homeMatches, 12);
  assert.equal(context.contextMeta.awayMatches, 8);
});

test("matches on/after kickoff are never counted (temporal safety)", () => {
  const db = openDb();
  const future = [row({ home: "PSV", away: "Foo", day: 70 }), row({ home: "Foo", away: "PSV Eindhoven", day: 80 })];
  importHistoryMatches(db, [...games("PSV", 6), ...future]);
  const found = getTeamLastMatches(db, { name: "PSV Eindhoven" }, KICKOFF, 20);
  assert.equal(found.length, 6);
  assert.ok(found.every(match => Date.parse(match.playedAt) < Date.parse(KICKOFF)));
  assert.equal(diagnoseFixtureHistory(db, FIXTURE).home.matched.total, 6);
});

test("venue maturity is not weakened: 20 games but only 2 at home keeps the HOME/AWAY split off", () => {
  const db = openDb();
  importHistoryMatches(db, [...games("PSV", 20, { homeCount: 2 }), ...games("Heerenveen", 20)]);
  const context = buildLocalHistoryContext([
    ...getTeamLastMatches(db, { name: "PSV Eindhoven" }, KICKOFF, 20), ...getTeamLastMatches(db, { name: "Heerenveen" }, KICKOFF, 20)
  ], FIXTURE);
  assert.equal(context.contextMeta.venueSplitMature, false);
  assert.equal(context.contextMeta.homeVenueMatches, 2);
  assert.deepEqual(context.standings.standings.map(group => group.type), ["TOTAL"]);
});

test("diagnostics separate real shortage, alias gap and immature venue split", () => {
  const db = openDb();
  importHistoryMatches(db, [
    ...games("Unalias Rovers", 3), ...games("Unalias", 6, { startDay: 10 }),   // other spelling holds the history
    ...games("Lonely Town", 2),                                                  // genuinely thin
    ...games("Venue Team", 12, { homeCount: 2 })                                 // enough games, few at home
  ]);
  const gap = diagnoseFixtureHistory(db, { home: "Unalias Rovers", away: "Lonely Town", utcDate: KICKOFF });
  assert.equal(gap.home.classification, "ALIAS_GAP_SUSPECTED");
  assert.ok(gap.home.unmatchedNameVariants.some(variant => variant.name === "Unalias" && variant.matches === 6));
  assert.equal(gap.away.classification, "REAL_HISTORY_SHORTAGE");
  const venue = diagnoseFixtureHistory(db, { home: "Venue Team", away: "Lonely Town", utcDate: KICKOFF });
  assert.equal(venue.home.classification, "VENUE_SPLIT_IMMATURE");
  assert.equal(venue.home.matched.home, 2);
  // Diagnostics expose names/sources/counts only.
  assert.deepEqual(Object.keys(gap.home.unmatchedNameVariants[0]).sort(), ["competitionCode", "matches", "name", "source"]);
  assert.deepEqual(findUnmatchedNameVariants(db, "Lonely Town", "2026-01-01T00:00:00Z"), []);
  assert.equal(classifyTeamHistory({ total: 4, venue: 4 }), "ENOUGH");
});

test("PR #2 regression: strict similarity no longer drops standings rows of PSV / Náutico / Athletico", () => {
  const cases = [
    [{ name: "PSV" }, { home: "PSV Eindhoven", homeId: 1 }, "home"],
    [{ name: "Clube Náutico Capibaribe" }, { home: "Náutico Recife", homeId: 1 }, "home"],
    [{ name: "CA Paranaense" }, { home: "Athletico Paranaense", homeId: 1 }, "home"],
    [{ name: "Grêmio Novorizontino" }, { home: "Novorizontino", homeId: 1 }, "home"]
  ];
  for (const [team, fixture] of cases) {
    const aligned = alignContextTeamIds({ standings: { standings: [{ type: "TOTAL", table: [{ team: { id: 99, ...team } }] }] }, finished: [] }, { away: "Zzz", awayId: 2, ...fixture });
    assert.equal(aligned.standings.standings[0].table[0].team.id, 1, `${team.name} -> ${fixture.home}`);
  }
  // The strictness that motivated PR #2 is kept.
  const kept = alignContextTeamIds({ standings: { standings: [{ type: "TOTAL", table: [{ team: { id: 3, name: "Queens Park FC" } }] }] }, finished: [] }, { home: "QPR", homeId: 72, away: "Middlesbrough", awayId: 70 });
  assert.equal(kept.standings.standings[0].table[0].team.id, 3);
});

test("explainModelShortfall names the real cause", () => {
  const fixture = { homeId: 1, awayId: 2 };
  const base = { fixture, competitionBaseline: null, rawBaseline: { sampleCurrentSeason: 0, samplePreviousSeason: 0 }, baseContext: { standings: null }, hasLocalModelContext: false };
  const table = ids => ({ standings: { standings: [{ type: "TOTAL", table: ids.map(id => ({ team: { id }, playedGames: 9 })) }] } });
  assert.equal(explainModelShortfall({ ...base, rawContext: table([1, 9]), alignedRawContext: table([1, 9]), localMeta: {} }).code, "LIVE_STANDINGS_TEAM_NOT_ALIGNED");
  assert.equal(explainModelShortfall({ ...base, rawContext: { standings: null }, localMeta: { homeMatches: 2, awayMatches: 20 } }).code, "LOCAL_HISTORY_THIN");
  assert.equal(explainModelShortfall({ ...base, rawContext: { standings: null }, localMeta: { homeMatches: 12, awayMatches: 20, homeVenueMatches: 2, awayVenueMatches: 10 } }).code, "VENUE_SPLIT_IMMATURE");
  assert.equal(explainModelShortfall({ ...base, rawContext: { standings: null }, localMeta: { homeMatches: 12, awayMatches: 20, homeVenueMatches: 6, awayVenueMatches: 10 } }).code, "NO_MODEL_CONTEXT");
  assert.equal(explainModelShortfall({ ...base, rawContext: { standings: null }, localMeta: {}, hasLocalModelContext: true }), null);
});

test("Telegram card shows the model shortfall reason", () => {
  const text = cardText({
    id: "f", home: "PSV Eindhoven", away: "Heerenveen", category: "WAIT", competition: "Eredivisie", utcDate: KICKOFF, dataQuality: 41,
    marketAvailable: true, markets: [], models: [], reason: "x",
    contextDiagnostic: { localHistory: { homeMatches: 2, awayMatches: 20 }, modelShortfall: { code: "LOCAL_HISTORY_THIN", detail: "матчей home 2, away 20, нужно ≥4" } }
  });
  assert.match(text, /Local history: <b>2\/20<\/b>/);
  assert.match(text, /Причина отсутствия модели: <b>LOCAL_HISTORY_THIN<\/b>/);
});
