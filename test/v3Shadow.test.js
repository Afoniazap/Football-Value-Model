import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyseFixture } from "../src/engine/analyse.js";
import { openHistoryDatabase, importHistoryMatches } from "../src/history/sqliteHistory.js";
import { getV3Snapshot, predictV3, resetV3SnapshotCache, V3_LEAGUES } from "../src/shadow/v3.js";
import { updateV3ShadowHistory, loadV3ShadowStatistics, buildV3ShadowStatistics } from "../src/shadow/v3History.js";

const config = { minDataQuality: 70, minEdge: 4, minEv: 5, minConfidence: 70, minStability: 70 };
const DAY = 86400000;

/** 4 teams, 6 finished matches in league PD, all well in the past relative to NOW. */
function makeSyntheticDb(now = Date.now()) {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-")), "history.sqlite");
  const db = openHistoryDatabase(dbPath);
  const base = now - 200 * DAY;
  const row = (offsetDays, home, away, hg, ag) => ({
    playedAt: new Date(base + offsetDays * DAY).toISOString(), status: "FT",
    homeTeam: { name: home }, awayTeam: { name: away },
    score: { fullTime: { home: hg, away: ag } },
    provenance: { source: "FOOTBALL_DATA" },
    competition: { code: "PD", name: "La Liga", season: "2025" }
  });
  importHistoryMatches(db, [
    row(0, "Alpha", "Beta", 0, 0), row(1, "Beta", "Alpha", 0, 1),
    row(2, "Gamma", "Delta", 1, 0), row(3, "Delta", "Gamma", 1, 1),
    row(4, "Alpha", "Gamma", 2, 1), row(5, "Beta", "Delta", 3, 2)
  ]);
  db.close();
  return dbPath;
}

test("temporal leakage: training set excludes any match at/after the cutoff", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const earlyCutoff = now - 250 * DAY; // before every synthetic match
  const early = getV3Snapshot(dbPath, earlyCutoff);
  assert.equal(early.trainingMatchCount, 0);

  resetV3SnapshotCache();
  const full = getV3Snapshot(dbPath, now);
  assert.equal(full.trainingMatchCount, 6);
});

test("trainedThrough is the actual latest training match kickoff, NOT the fit time -- distinct from snapshotCreatedAt/trainingCutoff", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const snapshot = getV3Snapshot(dbPath, now);
  assert.ok(snapshot.converged);
  const latestSyntheticMatchKickoff = now - 200 * DAY + 5 * DAY; // row(5, "Beta", "Delta", ...)
  assert.equal(snapshot.trainedThrough, latestSyntheticMatchKickoff, "trainedThrough must be the real latest match kickoff, not `now`");
  assert.equal(snapshot.snapshotCreatedAt, now, "snapshotCreatedAt is the fit's own wall-clock time");
  assert.equal(snapshot.trainingCutoff, now, "trainingCutoff is the filter boundary passed to beforeCutoff");
  assert.ok(snapshot.trainedThrough < snapshot.trainingCutoff, "trainedThrough must be strictly earlier than the cutoff parameter (there was a gap with no matches)");

  const fixture = { competitionCode: "PD", home: "Alpha", away: "Beta", utcDate: new Date(now + 3600_000).toISOString(), id: "f1" };
  const prediction = predictV3(fixture, snapshot);
  assert.equal(prediction.status, "PREDICTED");
  assert.equal(prediction.trainedThrough, latestSyntheticMatchKickoff);
  assert.equal(prediction.snapshotCreatedAt, now);
  assert.equal(prediction.trainingCutoff, now);
  assert.ok(prediction.trainedThrough < new Date(fixture.utcDate).getTime());
});

test("regression: a match immediately before the cutoff is trained on and sets trainedThrough exactly; a match after the cutoff is excluded entirely", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-boundary-")), "history.sqlite");
  const db = openHistoryDatabase(dbPath);
  const cutoff = now;
  const justBeforeCutoff = cutoff - 60_000; // 1 minute before the fit's cutoff -- must be included
  const afterCutoff = cutoff + 3600_000; // 1 hour after -- must be excluded (and is itself unfinished/future in reality)
  importHistoryMatches(db, [
    { playedAt: new Date(justBeforeCutoff).toISOString(), status: "FT", homeTeam: { name: "Alpha" }, awayTeam: { name: "Beta" }, score: { fullTime: { home: 1, away: 0 } }, provenance: { source: "FOOTBALL_DATA" }, competition: { code: "PD", name: "La Liga", season: "2025" } },
    // A "finished" row dated after the cutoff would only exist if the clock/cutoff were wrong -- beforeCutoff must still exclude it on pure timestamp grounds.
    { playedAt: new Date(afterCutoff).toISOString(), status: "FT", homeTeam: { name: "Gamma" }, awayTeam: { name: "Delta" }, score: { fullTime: { home: 2, away: 0 } }, provenance: { source: "FOOTBALL_DATA" }, competition: { code: "PD", name: "La Liga", season: "2025" } }
  ]);
  db.close();

  const snapshot = getV3Snapshot(dbPath, cutoff);
  assert.equal(snapshot.trainingMatchCount, 1, "only the before-cutoff match may be used for training");
  assert.equal(snapshot.trainedThrough, justBeforeCutoff, "trainedThrough must equal the one training match actually used, not the after-cutoff one");
  assert.ok(snapshot.trainedThrough < cutoff);
});

test("leakage guard rejects a fixture whose kickoff is not strictly after trainedThrough", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const snapshot = getV3Snapshot(dbPath, now);
  const atTrainedThrough = { competitionCode: "PD", home: "Alpha", away: "Beta", utcDate: new Date(snapshot.trainedThrough).toISOString(), id: "f2a" };
  assert.equal(predictV3(atTrainedThrough, snapshot).status, "FAILED");
  const beforeTrainedThrough = { competitionCode: "PD", home: "Alpha", away: "Beta", utcDate: new Date(snapshot.trainedThrough - 1000).toISOString(), id: "f2b" };
  const prediction = predictV3(beforeTrainedThrough, snapshot);
  assert.equal(prediction.status, "FAILED");
  assert.match(prediction.reason, /leakage guard/);
});

test("snapshot reuse: repeated calls within the TTL window return the SAME snapshot object (no refit)", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const first = getV3Snapshot(dbPath, now);
  const second = getV3Snapshot(dbPath, now + 5000);
  assert.equal(first, second, "must be the identical cached object, not a refit");
  const afterTtl = getV3Snapshot(dbPath, now + 31 * 60 * 1000);
  assert.notEqual(first, afterTtl, "must rebuild once the TTL window has elapsed");
});

test("a cached (reused) snapshot can never leak: every prediction re-checks trainedThrough against ITS OWN fixture, regardless of when within the TTL window it's used", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const snapshot = getV3Snapshot(dbPath, now); // trainedThrough is well in the past (see the trainedThrough-semantics test)

  // The SAME cached snapshot instance, reused for three different fixtures at
  // three different "current" moments within the TTL window.
  const safeFarFuture = predictV3({ competitionCode: "PD", home: "Alpha", away: "Beta", utcDate: new Date(now + 3600_000).toISOString(), id: "reuse-1" }, snapshot);
  assert.equal(safeFarFuture.status, "PREDICTED");

  const exactlyAtTrainedThrough = predictV3({ competitionCode: "PD", home: "Alpha", away: "Beta", utcDate: new Date(snapshot.trainedThrough).toISOString(), id: "reuse-2" }, snapshot);
  assert.equal(exactlyAtTrainedThrough.status, "FAILED");
  assert.match(exactlyAtTrainedThrough.reason, /leakage guard/, "a fixture at or before trainedThrough must be rejected even though the cached snapshot is otherwise valid and reused");

  const justAfterTrainedThrough = predictV3({ competitionCode: "PD", home: "Alpha", away: "Beta", utcDate: new Date(snapshot.trainedThrough + 1).toISOString(), id: "reuse-3" }, snapshot);
  assert.equal(justAfterTrainedThrough.status, "PREDICTED", "one millisecond after trainedThrough is safe -- the guard is a strict boundary, not an extra margin");

  // The reused snapshot's own training set never contains a match at/after trainedThrough+cutoff -- reuse doesn't change WHAT was trained on.
  assert.equal(snapshot.trainingMatchCount, 6);
});

test("unsupported competition returns an explicit SKIPPED status, never a global fallback", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const snapshot = getV3Snapshot(dbPath, now);
  const fixture = { competitionCode: "MLS", home: "Alpha", away: "Beta", utcDate: new Date(now + 3600_000).toISOString(), id: "f3" };
  const prediction = predictV3(fixture, snapshot);
  assert.deepEqual(prediction, { status: "SKIPPED", reason: "UNSUPPORTED_COMPETITION" });
  assert.ok(V3_LEAGUES.every(code => code !== "MLS"));
});

test("unseen team gets a finite league-average fallback, not NaN/Infinity, and is flagged unseenHome/unseenAway", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const snapshot = getV3Snapshot(dbPath, now);
  const fixture = { competitionCode: "PD", home: "Alpha", away: "Never Seen FC", utcDate: new Date(now + 3600_000).toISOString(), id: "f4" };
  const prediction = predictV3(fixture, snapshot);
  assert.equal(prediction.status, "PREDICTED");
  assert.equal(prediction.unseenHome, false);
  assert.equal(prediction.unseenAway, true);
  assert.ok(Number.isFinite(prediction.lambdaHome) && Number.isFinite(prediction.lambdaAway));
});

test("probabilities always sum to 1 within tolerance, for both DC and independent Poisson", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const snapshot = getV3Snapshot(dbPath, now);
  const fixture = { competitionCode: "PD", home: "Alpha", away: "Gamma", utcDate: new Date(now + 3600_000).toISOString(), id: "f5" };
  const prediction = predictV3(fixture, snapshot);
  assert.equal(prediction.status, "PREDICTED");
  for (const p of [prediction.probability, prediction.independentPoissonProbability]) {
    assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-6);
    assert.ok(["home", "draw", "away"].every(k => p[k] >= 0));
  }
});

test("an invalid/unreachable V3 dataset never throws out of updateV3ShadowHistory, and Production's own results stay untouched", () => {
  resetV3SnapshotCache();
  const now = new Date().toISOString();
  const fixture = { id: "f6", home: "Alpha", away: "Beta", competitionCode: "PD", utcDate: new Date(Date.now() + 3600_000).toISOString(), consensusProbability: { home: 0.4, draw: 0.3, away: 0.3 } };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-log-")), "v3-shadow.jsonl");
  const fixturesBefore = structuredClone([fixture]);
  assert.doesNotThrow(() => {
    const stats = updateV3ShadowHistory(file, [fixture], [], now, "/nonexistent/path/does-not-exist.sqlite");
    assert.equal(stats.failed, 1);
    assert.equal(stats.predicted, 0);
  });
  assert.deepEqual([fixture], fixturesBefore, "updateV3ShadowHistory must never mutate its fixtures argument");
});

test("transient V3_FAILED recovers into exactly one V3_PREDICTION once the problem clears, before kickoff; no duplicate afterwards; immutable after kickoff", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const goodDbPath = makeSyntheticDb(now);
  const brokenDbPath = "/nonexistent/path/does-not-exist.sqlite";
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-log-")), "v3-shadow.jsonl");
  const fixture = { id: "retry-1", home: "Alpha", away: "Beta", competitionCode: "PD", utcDate: new Date(now + 3600_000).toISOString() };

  // refresh1: DB unavailable -> V3_FAILED, not terminal.
  resetV3SnapshotCache();
  const stats1 = updateV3ShadowHistory(file, [fixture], [], new Date(now).toISOString(), brokenDbPath);
  assert.equal(stats1.predicted, 0);
  assert.equal(stats1.failed, 1);
  let records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(records.map(r => r.type), ["V3_FAILED"]);

  // refresh2 (still before kickoff): DB recovered -> exactly one V3_PREDICTION, and the fixture is no longer counted as failing.
  resetV3SnapshotCache();
  const stats2 = updateV3ShadowHistory(file, [fixture], [], new Date(now + 60_000).toISOString(), goodDbPath);
  assert.equal(stats2.predicted, 1);
  assert.equal(stats2.failed, 0, "a fixture that has since succeeded must not still be counted as failing");
  records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(records.map(r => r.type), ["V3_FAILED", "V3_PREDICTION"]);
  const predictedRecord = records.find(r => r.type === "V3_PREDICTION");

  // refresh3 (still before kickoff): must not add a second prediction.
  const stats3 = updateV3ShadowHistory(file, [fixture], [], new Date(now + 120_000).toISOString(), goodDbPath);
  assert.equal(stats3.predicted, 1, "exactly one successful prediction total -- no second one created");
  records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(records.filter(r => r.type === "V3_PREDICTION").length, 1);

  // refresh4 (after kickoff): the existing prediction must be byte-identical, untouched.
  const afterKickoff = updateV3ShadowHistory(file, [fixture], [], new Date(now + 4 * 3600_000).toISOString(), goodDbPath);
  records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const stillOnlyPrediction = records.filter(r => r.type === "V3_PREDICTION");
  assert.equal(stillOnlyPrediction.length, 1);
  assert.deepEqual(stillOnlyPrediction[0], predictedRecord);
});

test("restart/dedup: re-running the same tick never duplicates a fixture's V3 record", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-log-")), "v3-shadow.jsonl");
  const fixture = { id: "f7", home: "Alpha", away: "Beta", competitionCode: "PD", utcDate: new Date(now + 3600_000).toISOString() };
  const stats1 = updateV3ShadowHistory(file, [fixture], [], new Date(now).toISOString(), dbPath);
  assert.equal(stats1.predicted, 1);
  const stats2 = updateV3ShadowHistory(file, [fixture], [], new Date(now + 1000).toISOString(), dbPath);
  assert.equal(stats2.predicted, 1, "second tick (simulated restart) must not add a duplicate prediction");
  assert.equal(fs.readFileSync(file, "utf8").trim().split(/\r?\n/).length, 1);
});

test("pre-kickoff/post-kickoff immutability: a fixture's V3 prediction is fixed on first write, never revised by a later tick", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-log-")), "v3-shadow.jsonl");
  const fixture = { id: "f8", home: "Alpha", away: "Beta", competitionCode: "PD", utcDate: new Date(now + 3600_000).toISOString() };
  updateV3ShadowHistory(file, [fixture], [], new Date(now).toISOString(), dbPath);
  const firstRecord = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse).find(r => r.type === "V3_PREDICTION");

  // Simulate the DB changing (more matches ingested) before a later, still
  // pre-kickoff tick -- the already-written prediction must stay byte-identical.
  updateV3ShadowHistory(file, [fixture], [], new Date(now + 30 * 60 * 1000).toISOString(), dbPath);
  const secondRecord = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse).find(r => r.type === "V3_PREDICTION");
  assert.deepEqual(firstRecord, secondRecord);
});

test("regulation-time grading: V3_RESULT is written once the fixture is past kickoff and a finished result is available", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-log-")), "v3-shadow.jsonl");
  const fixture = { id: "f9", home: "Alpha", away: "Beta", competitionCode: "PD", utcDate: new Date(now + 3600_000).toISOString() };
  updateV3ShadowHistory(file, [fixture], [], new Date(now).toISOString(), dbPath);
  const finished = [{ sourceFixtureId: "changed", playedAt: fixture.utcDate, homeTeam: { name: "Alpha" }, awayTeam: { name: "Beta" }, score: { fullTime: { home: 2, away: 1 } }, status: "FT", provenance: { source: "FOOTBALL_DATA" } }];
  const stats = updateV3ShadowHistory(file, [], finished, new Date(now + 4 * 3600_000).toISOString(), dbPath);
  assert.equal(stats.completed, 1);
  const result = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse).find(r => r.type === "V3_RESULT");
  assert.equal(result.actual, "home");
  assert.ok(Number.isFinite(result.metrics.v3.logLoss) && Number.isFinite(result.metrics.v3.brier));
  assert.ok(Number.isFinite(result.metrics.independentPoisson.logLoss));
});

test("postponed/rescheduled fixture still grades via the shared exact-fixtureId path (resultMatching.js), same as dualShadow/predictionHistory", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-log-")), "v3-shadow.jsonl");
  const fixture = { id: "1552155", home: "Alpha", away: "Beta", competitionCode: "PD", utcDate: new Date(now + 3600_000).toISOString() };
  updateV3ShadowHistory(file, [fixture], [], new Date(now).toISOString(), dbPath);
  // Same fixtureId, actual kickoff drifted +3 days past the 12h name-match window.
  const rescheduledKickoff = new Date(new Date(fixture.utcDate).getTime() + 3 * DAY).toISOString();
  const finished = [{ sourceFixtureId: "1552155", playedAt: rescheduledKickoff, homeTeam: { name: "Alpha" }, awayTeam: { name: "Beta" }, score: { fullTime: { home: 1, away: 1 } }, status: "FT", provenance: { source: "API_FOOTBALL" } }];
  const stats = updateV3ShadowHistory(file, [], finished, new Date(now + 4 * DAY).toISOString(), dbPath);
  assert.equal(stats.completed, 1, "must grade via fixtureId despite the +3 day kickoff drift");
});

test("LogLoss/Brier are computed correctly and per-model completed counts never mix in a missing prediction as a fabricated zero", () => {
  const events = [
    { schemaVersion: 1, type: "V3_RESULT", snapshotKey: "k1", competitionCode: "PD", actual: "home", metrics: { v3: { logLoss: -Math.log(0.5), brier: 0.5 }, independentPoisson: { logLoss: -Math.log(0.4), brier: 0.6 }, production: null } },
    { schemaVersion: 1, type: "V3_RESULT", snapshotKey: "k2", competitionCode: "PD", actual: "draw", metrics: { v3: { logLoss: -Math.log(0.3), brier: 0.7 }, independentPoisson: { logLoss: -Math.log(0.3), brier: 0.7 }, production: { logLoss: -Math.log(0.25), brier: 0.8 } } }
  ];
  const stats = buildV3ShadowStatistics(events);
  assert.equal(stats.v3.completed, 2);
  assert.equal(stats.independentPoisson.completed, 2);
  assert.equal(stats.production.completed, 1, "production denominator excludes the fixture where production had no valid probability, not counted as a zero");
  assert.ok(Math.abs(stats.v3.logLoss - (-Math.log(0.5) - Math.log(0.3)) / 2) < 1e-9);
});

test("Production result/category is byte-for-byte identical whether V3 shadow logging runs or not", () => {
  resetV3SnapshotCache();
  const now = Date.now();
  const dbPath = makeSyntheticDb(now);
  const fixture = { id: "f10", homeId: 1, awayId: 2, home: "Alpha", away: "Beta", competition: "League", competitionCode: "PD", utcDate: new Date(now + 3600_000).toISOString() };
  const context = () => {
    const total = [
      { team: { id: 1, name: "Alpha" }, playedGames: 12, points: 24, goalsFor: 22, goalsAgainst: 12, goalDifference: 10 },
      { team: { id: 2, name: "Beta" }, playedGames: 12, points: 17, goalsFor: 15, goalsAgainst: 15, goalDifference: 0 }
    ];
    return { standings: { standings: [{ type: "TOTAL", table: total }, { type: "HOME", table: total }, { type: "AWAY", table: total }] }, finished: [], scheduled: [] };
  };
  const odds = () => ({ agreement: 70, bookmakers: [{}], best: { h2h: { home: { odds: 2.1, bookmaker: "Book" }, draw: { odds: 3.2, bookmaker: "Book" }, away: { odds: 3.6, bookmaker: "Book" } }, totals: {}, spreads: {} } });

  // "V3 OFF": Production computed alone.
  const productionOff = analyseFixture(fixture, context(), odds(), config);

  // "V3 ON": Production computed, then V3 shadow logging runs against the SAME fixture.
  const productionOn = analyseFixture(fixture, context(), odds(), config);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-v3-log-")), "v3-shadow.jsonl");
  updateV3ShadowHistory(file, [{ ...fixture, ...productionOn }], [], new Date(now).toISOString(), dbPath);

  const bettingRelevantKeys = ["consensusProbability", "dataQuality", "stability", "consensusScore", "category", "best", "markets", "reason"];
  for (const key of bettingRelevantKeys) assert.deepEqual(productionOn[key], productionOff[key]);
});
