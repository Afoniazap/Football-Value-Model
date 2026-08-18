import assert from "node:assert/strict";
import {
  assertNoTemporalLeakage,
  createPreMatchContext,
  rejectionReason,
  toModelFixture
} from "../src/historical/featureSnapshot.js";
import { resultFromScore } from "../src/historical/normalize.js";
import { buildModel } from "../src/model/probability.js";
import { multiclassBrier, logLoss } from "../src/backtest/metrics.js";
import { calibrationBins } from "../src/backtest/calibration.js";
import { runBaselineBacktest } from "../src/backtest/baselineBacktest.js";

function match(id, utcDate, homeTeamId, awayTeamId, homeGoals, awayGoals) {
  return {
    fixtureId: String(id),
    competition: "Test League",
    competitionCode: "TL",
    season: "2025",
    utcDate,
    homeTeamId,
    awayTeamId,
    homeTeam: `Team ${homeTeamId}`,
    awayTeam: `Team ${awayTeamId}`,
    homeGoals,
    awayGoals,
    result: resultFromScore(homeGoals, awayGoals)
  };
}

const historical = [
  match(1, "2026-01-01T12:00:00Z", 1, 3, 2, 0),
  match(2, "2026-01-02T12:00:00Z", 4, 1, 1, 1),
  match(3, "2026-01-03T12:00:00Z", 1, 5, 3, 1),
  match(4, "2026-01-04T12:00:00Z", 6, 1, 0, 1),
  match(5, "2026-01-05T12:00:00Z", 1, 7, 2, 2),
  match(6, "2026-01-01T12:00:00Z", 2, 8, 1, 0),
  match(7, "2026-01-02T12:00:00Z", 9, 2, 2, 1),
  match(8, "2026-01-03T12:00:00Z", 2, 10, 0, 0),
  match(9, "2026-01-04T12:00:00Z", 11, 2, 1, 2),
  match(10, "2026-01-05T12:00:00Z", 2, 12, 2, 2)
];
const target = match(20, "2026-01-10T12:00:00Z", 1, 2, 2, 1);

function testNoFutureMatchEntersFeatures() {
  const future = match(99, "2026-01-11T12:00:00Z", 1, 2, 9, 0);
  const context = createPreMatchContext(target, [...historical, target, future]);
  assert.ok(context.matches.every(item => new Date(item.utcDate) < new Date(target.utcDate)));
  assert.equal(context.matches.some(item => item.id === target.fixtureId), false);
  assert.equal(context.matches.some(item => item.id === future.fixtureId), false);
}

function testTemporalLeakageThrows() {
  assert.throws(
    () => assertNoTemporalLeakage(target, [historical[0], target]),
    /Temporal leakage/
  );
}

function testChronologicalOrdering() {
  const context = createPreMatchContext(target, [...historical].reverse());
  const times = context.matches.map(item => new Date(item.utcDate).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
}

function testProbabilitySumsToOneAndDeterministic() {
  const context = createPreMatchContext(target, historical);
  const modelFixture = toModelFixture(target);
  const first = buildModel(modelFixture, context);
  const second = buildModel(modelFixture, context);
  const sum = first.model.home + first.model.draw + first.model.away;
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.deepEqual(first.model, second.model);
}

function testMetrics() {
  const model = { home: 0.6, draw: 0.25, away: 0.15 };
  assert.ok(Math.abs(multiclassBrier(model, "H") - ((0.4 ** 2 + 0.25 ** 2 + 0.15 ** 2) / 3)) < 1e-12);
  assert.ok(Math.abs(logLoss(model, "H") - -Math.log(0.6)) < 1e-12);
}

function testCalibrationBins() {
  const rows = [
    { model: { home: 0.62, draw: 0.2, away: 0.18 }, actualResult: "H" },
    { model: { home: 0.68, draw: 0.2, away: 0.12 }, actualResult: "A" }
  ];
  const bin = calibrationBins(rows, "home").find(item => item.bin === "60-70");
  assert.equal(bin.sampleSize, 2);
  assert.ok(Math.abs(bin.meanPredicted - 0.65) < 1e-12);
  assert.ok(Math.abs(bin.actualFrequency - 0.5) < 1e-12);
}

function testEarlySeasonHandling() {
  const earlyTarget = match(30, "2026-01-02T12:00:00Z", 1, 2, 1, 1);
  const context = createPreMatchContext(earlyTarget, historical);
  assert.equal(rejectionReason(earlyTarget, context), "INSUFFICIENT_HISTORY");
  const report = runBaselineBacktest([historical[0], earlyTarget]);
  assert.equal(report.coverage.matchesUsable, 0);
  assert.ok(report.coverage.matchesRejected > 0);
}

testNoFutureMatchEntersFeatures();
testTemporalLeakageThrows();
testChronologicalOrdering();
testProbabilitySumsToOneAndDeterministic();
testMetrics();
testCalibrationBins();
testEarlySeasonHandling();

console.log("Stage 3 tests OK: temporal safety, metrics, calibration and early-season handling.");
