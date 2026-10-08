import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importHistoryMatches, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { buildCompetitionBaseline, pickCompetitionBaseline } from "../src/history/competitionBaseline.js";
import { alignContextTeamIds } from "../src/engine/contextIds.js";
import { calculateDataQuality } from "../src/engine/analyse.js";
import { TEAM_ALIAS_GROUPS, canonicalTeamName, sameTeamIdentity } from "../src/history/teamAliases.js";
import { describeDataQuality, diagnoseBaseline, diagnoseTeamHistory } from "../src/history/historyDiagnostics.js";
import { metricText } from "../src/ui/telegram.js";

const KICKOFF = "2026-10-09T18:45:00Z";
let seq = 0;
const openDb = () => openHistoryDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-dq-")), "football.sqlite"));
function row({ source = "FOOTBALL_DATA", ids, home, away, day, code = "DED", name = "Eredivisie", season = "2026", hg = 2, ag = 1 }) {
  seq += 1;
  return {
    recordKey: `${source}:${seq}`, sourceFixtureId: String(seq), status: "FINISHED", sport: "FOOTBALL",
    playedAt: new Date(Date.parse("2026-08-01T18:00:00Z") + day * 86400_000).toISOString(),
    competition: { code, name, season }, homeTeam: { id: ids[home], name: home }, awayTeam: { id: ids[away], name: away },
    score: { fullTime: { home: hg, away: ag } }, provenance: { source }, fetchedAt: "2026-10-01T00:00:00Z"
  };
}
const FD = { "PSV Eindhoven": 674, Heerenveen: 675, Ajax: 678, Feyenoord: 679 };
const AF = { "PSV Eindhoven": 197, Heerenveen: 210, Ajax: 194, Feyenoord: 209 };
const FIXTURE = { home: "PSV Eindhoven", away: "Heerenveen", homeId: 197, awayId: 210, competitionCode: "DED", seasonStart: "2026-08-01", utcDate: KICKOFF };

function mixedProviderLeague() {
  const out = [];
  let day = 0;
  for (let i = 0; i < 5; i += 1) {
    for (const [home, away] of [["PSV Eindhoven", "Heerenveen"], ["Heerenveen", "PSV Eindhoven"], ["Ajax", "PSV Eindhoven"], ["PSV Eindhoven", "Feyenoord"]]) out.push(row({ ids: FD, home, away, day: day++ }));
  }
  for (let i = 0; i < 5; i += 1) {
    for (const [home, away] of [["PSV Eindhoven", "Ajax"], ["Feyenoord", "PSV Eindhoven"], ["Heerenveen", "Ajax"], ["Ajax", "Heerenveen"]]) out.push(row({ source: "API_FOOTBALL", ids: AF, home, away, day: day++ }));
  }
  return out;
}

function tableRows(aligned, type, prefix) {
  return aligned.standings.standings.find(group => group.type === type).table.filter(entry => entry.team.name.startsWith(prefix));
}

test("baseline merges one club's rows from providers with different team ids (was split, first fragment used)", () => {
  const db = openDb();
  importHistoryMatches(db, mixedProviderLeague());
  const baseline = buildCompetitionBaseline(db, "DED", "2026", KICKOFF);
  assert.equal(baseline.current.baselineTeams, 4, "4 clubs, not 8 provider-id fragments");
  const aligned = alignContextTeamIds({ standings: baseline.current.standings, finished: [] }, FIXTURE);
  const total = tableRows(aligned, "TOTAL", "PSV");
  assert.equal(total.length, 1);
  assert.equal(total[0].playedGames, 30, "PSV real record = 20 (Football-Data) + 10 (API-Football)");
  assert.equal(tableRows(aligned, "HOME", "PSV")[0].playedGames + tableRows(aligned, "AWAY", "PSV")[0].playedGames, 30);
  assert.ok(pickCompetitionBaseline(baseline, FIXTURE, alignContextTeamIds));
});

test("other competitions (CL) never enter the Eredivisie baseline but stay in team history", () => {
  const db = openDb();
  const cl = Array.from({ length: 6 }, (_, i) => row({ ids: FD, home: i % 2 ? "PSV Eindhoven" : "Ajax", away: i % 2 ? "Ajax" : "PSV Eindhoven", day: 40 + i, code: "CL", name: "UEFA Champions League", hg: 5, ag: 0 }));
  importHistoryMatches(db, [...mixedProviderLeague(), ...cl]);
  const baseline = buildCompetitionBaseline(db, "DED", "2026", KICKOFF);
  assert.equal(baseline.sampleCurrentSeason, 40, "only the 40 DED rows");
  const aligned = alignContextTeamIds({ standings: baseline.current.standings, finished: [] }, FIXTURE);
  assert.equal(tableRows(aligned, "TOTAL", "PSV")[0].playedGames, 30);
  const history = diagnoseTeamHistory(db, "PSV Eindhoven", KICKOFF, { limit: 50 });
  assert.equal(history.matched.total, 36);
  assert.deepEqual(history.competitions.map(c => [c.code, c.matches]).sort(), [["CL", 6], ["DED", 30]]);
  const clBaseline = buildCompetitionBaseline(db, "CL", "2026", KICKOFF);
  assert.equal(clBaseline.sampleCurrentSeason, 6);
});

test("rows labelled only by name ('Eredivisie', no code) are excluded, never merged under the wrong code", () => {
  const db = openDb();
  const named = [row({ ids: FD, home: "Ajax", away: "Feyenoord", day: 50, code: null, name: "Eredivisie" })];
  importHistoryMatches(db, [...mixedProviderLeague(), ...named]);
  assert.equal(buildCompetitionBaseline(db, "DED", "2026", KICKOFF).sampleCurrentSeason, 40);
  const variants = diagnoseTeamHistory(db, "Ajax", KICKOFF, { limit: 50 }).competitions;
  assert.ok(variants.some(c => c.code === null && c.name === "Eredivisie"), "variant is visible in diagnostics");
});

test("Série A and Série B baselines do not mix (same season, different competition codes)", () => {
  const db = openDb();
  const ids = { "Athletico Paranaense": 1, "Atlético-MG": 2, Ceará: 3, "Criciúma": 4, "Náutico": 5, Novorizontino: 6 };
  const a = [], b = [];
  for (let i = 0; i < 8; i += 1) {
    a.push(row({ ids, home: i % 2 ? "Athletico Paranaense" : "Atlético-MG", away: i % 2 ? "Atlético-MG" : "Athletico Paranaense", day: i, code: "BSA", name: "Série A", season: "2026" }));
    b.push(row({ ids, home: i % 2 ? "Náutico" : "Novorizontino", away: i % 2 ? "Novorizontino" : "Náutico", day: i, code: "BSB", name: "Série B", season: "2026" }));
  }
  importHistoryMatches(db, [...a, ...b]);
  assert.equal(buildCompetitionBaseline(db, "BSA", "2026", KICKOFF).sampleCurrentSeason, 8);
  assert.equal(buildCompetitionBaseline(db, "BSB", "2026", KICKOFF).sampleCurrentSeason, 8);
  // Only 2 clubs in the competition: not a genuine baseline (MIN_TEAMS_FOR_GENUINE_BASELINE=3).
  assert.equal(buildCompetitionBaseline(db, "BSB", "2026", KICKOFF).current, null);
});

test("baseline is temporally safe: rows at/after kickoff are excluded", () => {
  const db = openDb();
  importHistoryMatches(db, [...mixedProviderLeague(), row({ ids: FD, home: "PSV Eindhoven", away: "Ajax", day: 70 }), row({ ids: FD, home: "Ajax", away: "PSV Eindhoven", day: 71 })]);
  assert.equal(buildCompetitionBaseline(db, "DED", "2026", KICKOFF).sampleCurrentSeason, 40);
});

test("diagnoseBaseline reports tier sample, per-team record and whether it would be picked", () => {
  const db = openDb();
  importHistoryMatches(db, mixedProviderLeague());
  const report = diagnoseBaseline(db, FIXTURE, "2026");
  assert.equal(report.current.built, true);
  assert.equal(report.current.teams, 4);
  assert.equal(report.current.home.total, 30);
  assert.equal(report.current.picked, true);
  assert.equal(report.previous.built, false);
  const thin = diagnoseBaseline(db, { ...FIXTURE, home: "Ajax", away: "Feyenoord" }, "2026");
  assert.equal(thin.current.picked, true);
  const none = diagnoseBaseline(db, { ...FIXTURE, competitionCode: "BSB" }, "2026");
  assert.equal(none.current.built, false);
});

test("Data Quality 65 is exactly the existing formula: 7 + 10 + 15 + 15 + 15 + 0 + 3 (diagnostic reconstruction)", () => {
  const finished = Array.from({ length: 40 }, () => ({}));
  const context = { finished, standings: { standings: [{ type: "TOTAL" }, { type: "HOME" }, { type: "AWAY" }] } };
  const odds = { bookmakers: Array.from({ length: 20 }, () => ({})) };
  const { dataQuality, dataQualityV2 } = calculateDataQuality(context, odds, { form: true }, { injuriesAvailable: true, lineupsAvailable: false, confirmedLineups: false });
  assert.equal(dataQuality, 65);
  const breakdown = describeDataQuality(dataQualityV2, dataQuality);
  assert.deepEqual(breakdown.components.map(c => c.value), [7, 10, 15, 15, 15, 0, 3]);
  assert.equal(breakdown.maxPossible, 85);
  assert.equal(breakdown.components.find(c => c.component === "sampleScore").missing, 13);
  assert.equal(breakdown.components.find(c => c.component === "squadScore").missing, 7);
  // With every local match of both clubs AND confirmed lineups the formula still tops out at 72 for 40 rows.
  const best = calculateDataQuality(context, odds, { form: true }, { injuriesAvailable: true, lineupsAvailable: true, confirmedLineups: true });
  assert.equal(best.dataQuality, 72);
});

test("Telegram DQ breakdown shows each component with its maximum", () => {
  const text = metricText("DQ", { dataQuality: 65, dataQualityV2: { sampleScore: 7, freshnessScore: 10, homeAwayScore: 15, formScore: 15, marketScore: 15, xgScore: 0, xgAvailable: false, squadScore: 3 }, valueThresholds: {} });
  assert.match(text, /Выборка матчей: \+7 из 20/);
  assert.match(text, /Составы: \+3 из 10/);
  assert.match(text, /максимум по текущей формуле 85/);
});

test("alias table invariants: no canonical spelling belongs to two groups, audited clubs stay distinct", () => {
  const owner = new Map();
  for (const group of TEAM_ALIAS_GROUPS) {
    for (const alias of [group.name, ...group.aliases]) {
      const key = canonicalTeamName(alias);
      assert.ok(!owner.has(key) || owner.get(key) === group.name, `${alias} claimed by ${owner.get(key)} and ${group.name}`);
      owner.set(key, group.name);
    }
  }
  const clubs = ["PSV Eindhoven", "Heerenveen", "Ceará", "Criciúma", "Náutico Recife", "Novorizontino", "Athletico Paranaense", "Atlético-MG", "Atlético Madrid", "Atlético Nacional", "Grêmio", "Sport Recife", "Cruzeiro"];
  for (const a of clubs) for (const b of clubs) if (a < b) assert.equal(sameTeamIdentity(a, b), false, `${a} != ${b}`);
});
