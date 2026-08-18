import assert from "node:assert/strict";
import {
  createPreMatchContext,
  rejectionReason
} from "../src/historical/featureSnapshot.js";
import { resultFromScore } from "../src/historical/normalize.js";
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

const history = [
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

function table(context, type) {
  return context.standings.standings.find(item => item.type === type).table;
}

function row(context, type, teamId) {
  return table(context, type).find(item => item.team.id === teamId);
}

function testChronologicalStandingsReconstruction() {
  const context = createPreMatchContext(target, [...history].reverse());
  assert.deepEqual(row(context, "TOTAL", 1), {
    team: { id: 1 },
    playedGames: 5,
    points: 11,
    goalsFor: 9,
    goalsAgainst: 4,
    goalDifference: 5
  });
}

function testHomeAwaySplitReconstruction() {
  const context = createPreMatchContext(target, history);
  assert.deepEqual(row(context, "HOME", 1), {
    team: { id: 1 },
    playedGames: 3,
    points: 7,
    goalsFor: 7,
    goalsAgainst: 3,
    goalDifference: 4
  });
  assert.deepEqual(row(context, "AWAY", 1), {
    team: { id: 1 },
    playedGames: 2,
    points: 4,
    goalsFor: 2,
    goalsAgainst: 1,
    goalDifference: 1
  });
}

function testTargetAndFutureExcluded() {
  const future = match(99, "2026-01-11T12:00:00Z", 1, 2, 9, 0);
  const context = createPreMatchContext(target, [...history, target, future]);
  assert.equal(context.matches.some(item => item.id === target.fixtureId), false);
  assert.equal(context.matches.some(item => item.id === future.fixtureId), false);
  assert.ok(context.matches.every(item => new Date(item.utcDate) < new Date(target.utcDate)));
}

function testMinimumHistoryRejection() {
  const tooEarly = match(21, "2026-01-04T18:00:00Z", 1, 2, 1, 0);
  const context = createPreMatchContext(tooEarly, history);
  assert.equal(rejectionReason(tooEarly, context, 5), "INSUFFICIENT_HISTORY");
}

function testDeterministicReconstructionAndBacktestEligibility() {
  const first = createPreMatchContext(target, [...history].reverse());
  const second = createPreMatchContext(target, history);
  assert.deepEqual(first, second);

  const report = runBaselineBacktest([...history, target], { minimumPriorMatches: 5 });
  assert.ok(report.coverage.matchesUsable >= 1);
  const prediction = report.predictions.find(item => item.fixtureId === target.fixtureId);
  assert.equal(prediction.snapshotMeta.teamHistoryMin, 5);
}

testChronologicalStandingsReconstruction();
testHomeAwaySplitReconstruction();
testTargetAndFutureExcluded();
testMinimumHistoryRejection();
testDeterministicReconstructionAndBacktestEligibility();

console.log("Stage 3.5 tests OK: real-baseline reconstruction guards and eligibility.");
