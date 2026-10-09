import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importHistoryMatches, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { analyseFixture } from "../src/engine/analyse.js";
import { extractMarkets } from "../src/connectors/odds.js";
import { controlTuple, summarize } from "../scripts/baseline/lib.mjs";
import { legacyIdentitySnapshot } from "../scripts/baseline/identity-legacy-snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, ...argv) => spawnSync("node", ["--no-warnings", path.join(ROOT, "scripts", "baseline", script), ...argv], { cwd: ROOT, encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fvm-baseline-"));

const team = (id, name, pg, gf, ga, pts) => ({ team: { id, name }, playedGames: pg, goalsFor: gf, goalsAgainst: ga, points: pts, won: 0, draw: 0, lost: 0 });
function analysedState() {
  const table = [team(1, "PSV", 8, 24, 6, 22), team(2, "Heerenveen", 8, 10, 12, 10), team(3, "Ajax", 8, 15, 9, 16), team(4, "Utrecht", 8, 9, 11, 10)];
  const finished = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, utcDate: `2026-09-${String(i + 1).padStart(2, "0")}T18:00:00Z`, homeTeam: { id: 1 + (i % 2), name: i % 2 ? "Heerenveen" : "PSV" }, awayTeam: { id: 3 + (i % 2), name: "X" }, score: { fullTime: { home: 2, away: i % 3 } } }));
  const context = { standings: { standings: ["TOTAL", "HOME", "AWAY"].map(type => ({ type, table })) }, finished, scheduled: [] };
  const book = (title, home, draw, away) => ({ title, markets: [{ key: "h2h", outcomes: [{ name: "PSV", price: home }, { name: "Draw", price: draw }, { name: "Heerenveen", price: away }] }] });
  const event = { home_team: "PSV", away_team: "Heerenveen", commence_time: "2026-10-09T18:45:00Z", bookmakers: [book("A", 1.4, 5.2, 7.5), book("B", 1.42, 5.0, 8.5)] };
  const fixture = { id: "9", home: "PSV", away: "Heerenveen", homeId: 1, awayId: 2, utcDate: "2026-10-09T18:45:00Z", competitionCode: "DED" };
  const result = analyseFixture(fixture, context, extractMarkets(event), { minEdge: 4, minEv: 5, minConfidence: 70, minDataQuality: 70, minStability: 60 });
  return { updatedAt: "2026-10-09T05:34:00Z", results: [{ ...result, contextDiagnostic: { source: "COMPETITION_BASELINE", localHistory: { homeMatches: 20, awayMatches: 20, homeVenueMatches: 10, awayVenueMatches: 10, venueSplitMature: true }, baseline: { baselineSource: "CURRENT_SEASON", baselineSample: 40, baselineTeams: 4 } }, marketDiagnostic: { selectedSource: "THE_ODDS_API", freshness: "FRESH", normalizedBookmakers: 2 } }] };
}

function workspace() {
  const dir = tmp();
  const state = analysedState();
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  fs.mkdirSync(path.join(dir, "snaps"));
  fs.writeFileSync(path.join(dir, "snaps", "state-2026-10-09T05-18-00Z.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, "snaps", "state-2026-10-09T05-34-00Z.json"), JSON.stringify(state));
  const db = openHistoryDatabase(path.join(dir, "football.sqlite"));
  const row = (source, id, home, away) => ({ recordKey: `${source}:${id}`, sourceFixtureId: String(id), status: "FINISHED", sport: "FOOTBALL", playedAt: "2026-09-01T18:45:00Z", competition: { code: "DED", name: "E", season: "2026" }, homeTeam: { id: id, name: home }, awayTeam: { id: 50 + id, name: away }, score: { fullTime: { home: 2, away: 1 } }, provenance: { source }, fetchedAt: "2026-10-01T00:00:00Z" });
  importHistoryMatches(db, [row("FOOTBALL_DATA", 1, "PSV", "SC Heerenveen"), row("API_FOOTBALL", 2, "PSV Eindhoven", "Heerenveen")].map((r, i) => ({ ...r, playedAt: i ? "2026-09-01T18:50:00Z" : r.playedAt })));
  db.close();
  fs.mkdirSync(path.join(dir, "stats"));
  fs.writeFileSync(path.join(dir, "stats", "predictions.jsonl"), `${JSON.stringify({ type: "PREDICTION", modelVersion: "production-baseline-v1", category: "NO_BET" })}\n`);
  return dir;
}
const captureArgs = (dir, out) => ["--state", path.join(dir, "state.json"), "--snapshots", path.join(dir, "snaps"), "--db", path.join(dir, "football.sqlite"), "--predictions", path.join(dir, "stats", "predictions.jsonl"), "--out", out];

test("controlTuple keeps the owner's control values from real analyseFixture output and never copies provider text", () => {
  const [result] = analysedState().results;
  const tuple = controlTuple({ ...result, providerError: "apiKey=SECRET" });
  for (const key of ["category", "modelsAvailable", "modelCoverage", "dq", "agreement", "stability", "consensus", "models", "best", "dqParts", "history"]) assert.ok(key in tuple, key);
  assert.equal(JSON.stringify(tuple).includes("SECRET"), false);
  assert.ok(Math.abs(tuple.consensus.home + tuple.consensus.draw + tuple.consensus.away - 1) < 1e-5);
  const summary = summarize([tuple]);
  assert.equal(summary.fixtures, 1);
  assert.equal(summary.modelsAvailable[2], 1);
});

test("capture is read-only, deterministic (same digest on rerun) and records db/state/predictions/series", () => {
  const dir = workspace();
  const dbBefore = fs.readFileSync(path.join(dir, "football.sqlite"));
  const a = run("capture.mjs", ...captureArgs(dir, path.join(dir, "out-a")));
  const b = run("capture.mjs", ...captureArgs(dir, path.join(dir, "out-b")));
  assert.equal(a.status, 0, a.stderr);
  const first = JSON.parse(fs.readFileSync(path.join(dir, "out-a", "baseline.json"), "utf8"));
  const second = JSON.parse(fs.readFileSync(path.join(dir, "out-b", "baseline.json"), "utf8"));
  assert.equal(first.digest, second.digest);
  assert.equal(first.state.summary.fixtures, 1);
  assert.equal(first.db.matches, 2);
  assert.equal(first.db.identityKeyDuplicates, 0, "monitoring-blind spot: the same match under two spellings is not an identityKey duplicate");
  assert.equal(first.predictions.byType.PREDICTION, 1);
  const series = JSON.parse(fs.readFileSync(path.join(dir, "out-a", "snapshots.json"), "utf8"));
  assert.equal(Object.values(series)[0].length, 2, "two saved states -> two points in the series");
  assert.equal(Buffer.compare(dbBefore, fs.readFileSync(path.join(dir, "football.sqlite"))), 0, "SQLite untouched");
  assert.equal(b.status, 0, b.stderr);
});

test("compare passes on identical baselines and fails (exit 1) when a locked value moves", () => {
  const dir = workspace();
  run("capture.mjs", ...captureArgs(dir, path.join(dir, "before")));
  run("capture.mjs", ...captureArgs(dir, path.join(dir, "after")));
  const same = run("compare.mjs", path.join(dir, "before", "baseline.json"), path.join(dir, "after", "baseline.json"));
  assert.equal(same.status, 0, same.stdout);
  const mutated = JSON.parse(fs.readFileSync(path.join(dir, "after", "baseline.json"), "utf8"));
  mutated.state.fixtures[0].consensus.draw += 0.01;
  mutated.state.fixtures[0].category = "NEAR";
  fs.writeFileSync(path.join(dir, "after", "baseline.json"), JSON.stringify(mutated));
  const moved = run("compare.mjs", path.join(dir, "before", "baseline.json"), path.join(dir, "after", "baseline.json"));
  assert.equal(moved.status, 1);
  const report = JSON.parse(moved.stdout);
  assert.ok(report.lockedDifferences >= 2);
  assert.ok(report.locked.some(d => d.field === "category" && d.after === "NEAR"));
  assert.equal(run("compare.mjs", path.join(dir, "before", "baseline.json"), path.join(dir, "after", "baseline.json"), "--tolerance", "0.02").status, 1, "category change is still locked");
});

test("censuses and corpus tools run on a database and report the alias candidate from data", () => {
  const dir = workspace();
  const census = run("identity-census.mjs", path.join(dir, "football.sqlite"));
  assert.equal(census.status, 0, census.stderr);
  const report = JSON.parse(census.stdout);
  assert.equal(report.totals.matches, 2);
  assert.ok(report.aliasCandidates.some(c => c.spellings.includes("psv") && c.spellings.includes("psv eindhoven")));
  const corpus = run("name-corpus.mjs", path.join(dir, "football.sqlite"), path.join(dir, "state.json"));
  assert.equal(corpus.status, 0, corpus.stderr);
  const names = JSON.parse(corpus.stdout);
  assert.ok(names.some(n => n.name === "PSV Eindhoven" && n.kind === "sqlite"));
  assert.ok(names.some(n => n.name === "Heerenveen" && n.kind === "fixture"));
  const dup = run("fixture-dup-census.mjs", path.join(dir, "state.json"));
  assert.equal(dup.status, 0, dup.stderr);
  assert.deepEqual(JSON.parse(dup.stdout).suspectedDuplicateFixtures, []);
});

test("freeze-db makes a standalone copy and leaves the source untouched", () => {
  const dir = workspace();
  const source = path.join(dir, "football.sqlite");
  const before = fs.readFileSync(source);
  const frozen = path.join(dir, "frozen", "football.frozen.sqlite");
  const r = run("freeze-db.mjs", source, frozen);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).matches, 2);
  assert.equal(Buffer.compare(before, fs.readFileSync(source)), 0);
  assert.equal(run("freeze-db.mjs", source, frozen).status, 2, "never overwrites an existing frozen copy");
});

test("legacy identity snapshot is deterministic and records today's behaviour (golden input for P1)", () => {
  const corpus = ["PSV", "PSV Eindhoven", "SC Heerenveen", "Heerenveen", "Willem II", "Willem II Tilburg", "Manchester United", "Manchester City", "Santos", "Santos Laguna"]
    .map(name => ({ competition: "DED", source: "S", name, kind: "sqlite", rows: 1 }));
  const first = legacyIdentitySnapshot(corpus), second = legacyIdentitySnapshot([...corpus].reverse());
  assert.equal(first.digest, second.digest, "independent of input order");
  const classes = first.sections.historyClasses.DED.map(c => c.join(" = "));
  assert.ok(classes.includes("PSV = PSV Eindhoven"));
  assert.ok(classes.includes("Heerenveen = SC Heerenveen"));
  assert.equal(first.sections.oddsPairs.DED.some(([a, b]) => a === "Santos" && b === "Santos Laguna"), false);
  assert.equal(first.sections.oddsPairs.DED.some(([a, b]) => a === "Manchester City" && b === "Manchester United"), false);
  assert.deepEqual(first.sections.contextAlignment.DED["PSV Eindhoven"], ["PSV", "PSV Eindhoven"]);
});
