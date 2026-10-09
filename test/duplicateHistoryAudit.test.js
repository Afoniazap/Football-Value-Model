import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dedupeLogicalMatches, findLogicalDuplicates, getCompetitionSeasonMatches, getHeadToHead, getTeamAwayMatches,
  getTeamHomeMatches, getTeamLastMatches, importHistoryMatches, openHistoryDatabase
} from "../src/history/sqliteHistory.js";
import { buildCompetitionBaseline } from "../src/history/competitionBaseline.js";
import { auditFixtureForecast } from "../scripts/audit-fixture-forecast.js";

const BEFORE = "2026-10-09T18:45:00Z";
const openDb = () => openHistoryDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-dup-")), "football.sqlite"));
let seq = 0;
function row({ source, home, away, playedAt, hid = null, aid = null, hg = 2, ag = 1, code = "DED" }) {
  seq += 1;
  return {
    recordKey: `${source}:${seq}`, sourceFixtureId: String(seq), status: "FINISHED", sport: "FOOTBALL", playedAt,
    competition: { code, name: "Eredivisie", season: "2026" }, homeTeam: { id: hid, name: home }, awayTeam: { id: aid, name: away },
    score: { fullTime: { home: hg, away: ag } }, provenance: { source }, fetchedAt: "2026-10-01T00:00:00Z"
  };
}
const slot = (i, step = 7) => new Date(Date.parse("2026-08-02T18:45:00Z") + i * step * 86400_000);

// The SAME six PSV home matches delivered by two providers: different PSV spelling, kickoff drift.
function sameMatchesTwice(n = 6, step = 7) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(row({ source: "FOOTBALL_DATA", home: "PSV", away: `Opp${i}`, playedAt: slot(i, step).toISOString(), hid: 674, aid: 100 + i }));
    rows.push(row({ source: "API_FOOTBALL", home: "PSV Eindhoven", away: `Opp${i}`, playedAt: new Date(slot(i, step).getTime() + (i % 2 ? 0 : 15 * 60_000)).toISOString(), hid: 197, aid: 200 + i }));
  }
  return rows;
}

test("one real match stored under two spellings is counted once (was 12 for 6 real matches)", () => {
  const db = openDb();
  assert.equal(importHistoryMatches(db, sameMatchesTwice()).inserted, 12, "SQLite keeps both rows: identityKey is not alias-aware");
  assert.equal(getTeamLastMatches(db, { name: "PSV Eindhoven" }, BEFORE, 20).length, 6);
  assert.equal(getTeamHomeMatches(db, { name: "PSV Eindhoven" }, BEFORE, 20).length, 6);
  assert.equal(getTeamAwayMatches(db, { name: "PSV Eindhoven" }, BEFORE, 20).length, 0);
  const baseline = buildCompetitionBaseline(db, "DED", "2026", BEFORE);
  assert.equal(baseline.sampleCurrentSeason, 6);
  assert.equal(getCompetitionSeasonMatches(db, "DED", "2026", BEFORE).length, 6);
  assert.equal(baseline.current.standings.standings[0].table.find(entry => entry.team.name.startsWith("PSV")).playedGames, 6);
});

test("limit is applied after collapsing duplicates", () => {
  const db = openDb();
  importHistoryMatches(db, sameMatchesTwice(25, 1));
  const last = getTeamLastMatches(db, { name: "PSV" }, BEFORE, 20);
  assert.equal(last.length, 20);
  assert.equal(new Set(last.map(match => match.playedAt.slice(0, 10))).size, 20, "20 distinct real matches");
});

test("genuinely different matches are never collapsed", () => {
  const rows = [
    row({ source: "FOOTBALL_DATA", home: "PSV", away: "Heerenveen", playedAt: "2026-08-02T18:45:00Z" }),
    row({ source: "FOOTBALL_DATA", home: "PSV", away: "Heerenveen", playedAt: "2026-09-02T18:45:00Z" }),       // rematch a month later
    row({ source: "FOOTBALL_DATA", home: "Heerenveen", away: "PSV", playedAt: "2026-08-02T20:00:00Z" }),       // reversed fixture
    row({ source: "FOOTBALL_DATA", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z" })               // other opponent, same time
  ].map(entry => ({ ...entry, homeTeam: { ...entry.homeTeam, name: entry.homeTeam.name }, decoded: true }));
  const decoded = rows.map((entry, index) => ({ ...entry, recordKey: `SQLITE:${index}` }));
  assert.equal(dedupeLogicalMatches(decoded).length, 4);
  assert.equal(findLogicalDuplicates(decoded).length, 0);
});

test("head-to-head also collapses the double-stored fixture", () => {
  const db = openDb();
  importHistoryMatches(db, [
    row({ source: "FOOTBALL_DATA", home: "PSV", away: "SC Heerenveen", playedAt: "2026-08-02T18:45:00Z" }),
    row({ source: "API_FOOTBALL", home: "PSV Eindhoven", away: "Heerenveen", playedAt: "2026-08-02T18:50:00Z" })
  ]);
  assert.equal(getHeadToHead(db, "PSV Eindhoven", "Heerenveen", BEFORE, 20).length, 1);
});

test("temporal safety is unchanged by de-duplication", () => {
  const db = openDb();
  importHistoryMatches(db, [...sameMatchesTwice(3), row({ source: "FOOTBALL_DATA", home: "PSV", away: "Late", playedAt: "2026-10-09T18:45:00Z" })]);
  assert.equal(getTeamLastMatches(db, { name: "PSV" }, BEFORE, 20).length, 3);
});

test("forecast audit: duplicates are reported, lambda origin and 1X2 sum to 1, same data gives one record per match", () => {
  const db = openDb();
  const teams = ["PSV", "Heerenveen", "Ajax", "Feyenoord"];
  const rows = [];
  let n = 0;
  for (let i = 0; i < 10; i += 1) {
    for (const [home, away] of [["PSV", "Heerenveen"], ["Heerenveen", "Ajax"], ["Ajax", "PSV"], ["Feyenoord", "PSV"]]) {
      n += 1;
      const at = new Date(Date.parse("2026-08-01T18:00:00Z") + n * 86400_000 / 2).toISOString();
      rows.push(row({ source: "FOOTBALL_DATA", home, away, playedAt: at, hid: teams.indexOf(home) + 1, aid: teams.indexOf(away) + 1, hg: i % 3, ag: (i + 1) % 2 }));
    }
  }
  importHistoryMatches(db, rows);
  const fixture = { home: "PSV", away: "Heerenveen", competitionCode: "DED", utcDate: BEFORE };
  const report = auditFixtureForecast(db, fixture, { season: "2026" });
  assert.equal(report.historyRows.logicalDuplicateGroups.length, 0);
  assert.equal(report.baseline.tier, "CURRENT_SEASON");
  assert.equal(report.baseline.teams, 4);
  const probability = report.models.teamStrength.probability;
  assert.ok(Math.abs(probability.home + probability.draw + probability.away - 1) < 1e-3);
  assert.ok(report.lambdaOrigin.lambda.home > 0 && report.lambdaOrigin.homeTeamAtHome.played > 0);
  // Storing every match a second time under another spelling must not change the forecast at all.
  const doubled = openDb();
  importHistoryMatches(doubled, [...rows, ...rows.map(entry => ({
    ...entry, recordKey: `API_FOOTBALL:${entry.recordKey}`, provenance: { source: "API_FOOTBALL" },
    homeTeam: { ...entry.homeTeam, name: entry.homeTeam.name === "PSV" ? "PSV Eindhoven" : entry.homeTeam.name },
    awayTeam: { ...entry.awayTeam, name: entry.awayTeam.name === "PSV" ? "PSV Eindhoven" : entry.awayTeam.name },
    playedAt: new Date(Date.parse(entry.playedAt) + 600_000).toISOString()
  }))]);
  const again = auditFixtureForecast(doubled, fixture, { season: "2026" });
  assert.deepEqual(again.models.teamStrength.probability, report.models.teamStrength.probability);
  assert.deepEqual(again.lambdaOrigin.lambda, report.lambdaOrigin.lambda);
  assert.equal(again.baseline.sample, report.baseline.sample);
});

test("forecast audit explains Edge vs EV: EV uses the best price of any book, Edge the benchmark book's no-vig probability", () => {
  const db = openDb();
  const teams = ["PSV", "Heerenveen", "Ajax", "Feyenoord"];
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    const [home, away] = [["PSV", "Heerenveen"], ["Heerenveen", "Ajax"], ["Ajax", "PSV"], ["Feyenoord", "PSV"]][i % 4];
    rows.push(row({ source: "FOOTBALL_DATA", home, away, playedAt: new Date(Date.parse("2026-08-01T18:00:00Z") + i * 43200_000).toISOString(), hid: teams.indexOf(home) + 1, aid: teams.indexOf(away) + 1, hg: (i % 3) + 1, ag: i % 2 }));
  }
  importHistoryMatches(db, rows);
  const book = (title, home, draw, away) => ({ title, markets: [{ key: "h2h", outcomes: [{ name: "PSV", price: home }, { name: "Draw", price: draw }, { name: "Heerenveen", price: away }] }] });
  const event = { home_team: "PSV", away_team: "Heerenveen", commence_time: BEFORE, sport_key: "soccer_netherlands_eredivisie", bookmakers: [
    book("BookA", 1.30, 5.5, 8.0), book("BookB", 1.31, 5.4, 8.1), book("BookC", 1.30, 5.6, 8.0), book("Outlier", 1.28, 5.2, 8.5)
  ] };
  const report = auditFixtureForecast(db, { home: "PSV", away: "Heerenveen", competitionCode: "DED", utcDate: BEFORE }, { season: "2026", oddsEvents: [event] });
  assert.equal(report.market.bookmakers, 4);
  assert.equal(report.market.prices.away.best.odds, 8.5);
  assert.equal(report.market.prices.away.best.bookmaker, "Outlier");
  assert.equal(report.market.prices.away.bestVsSecondPct, 4.9);
  const away = report.market.candidates.find(candidate => candidate.label === "П2");
  assert.equal(away.bestOdds, 8.5);
  assert.equal(away.evPct, away.evFromEdgeParts);
  assert.ok(Math.abs(away.edgePp - (away.modelProbability - away.benchmarkNoVigProbability) * 100) < 0.02);
  assert.ok(away.bestBookmaker !== away.benchmarkBookmaker, "best price and benchmark are different books");
});
