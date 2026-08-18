import assert from "node:assert/strict";
import { createPreMatchContext, toModelFixture } from "../src/historical/featureSnapshot.js";
import { resultFromScore } from "../src/historical/normalize.js";
import { buildChallengerModel, CHALLENGER_VARIANTS } from "../src/model/challenger/probability.js";
import { buildEloSnapshot, eloDiagnostic } from "../src/model/challenger/elo.js";
import { formLambdaFactors } from "../src/model/challenger/formAdjustment.js";
import { outcomeProbabilities, scoreMatrix } from "../src/model/challenger/poisson.js";
import { shrinkRate } from "../src/model/challenger/teamStrength.js";

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

function testPoissonProbabilitiesSumToOne() {
  const probabilities = outcomeProbabilities(1.45, 1.05);
  const sum = probabilities.home + probabilities.draw + probabilities.away;
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.ok(probabilities.scoreMatrix.every(row => row.probability >= 0 && row.probability <= 1));
}

function testScoreMatrixDeterministic() {
  assert.deepEqual(scoreMatrix(1.4, 0.9), scoreMatrix(1.4, 0.9));
}

function testNoFutureData() {
  const future = match(99, "2026-01-11T12:00:00Z", 1, 2, 9, 0);
  const context = createPreMatchContext(target, [...history, target, future]);
  assert.equal(context.matches.some(item => item.id === future.fixtureId), false);
}

function testEloOnlyUpdatesChronologically() {
  const context = createPreMatchContext(target, history);
  const reversed = createPreMatchContext(target, [...history].reverse());
  assert.deepEqual(
    [...buildEloSnapshot(context).ratings.entries()],
    [...buildEloSnapshot(reversed).ratings.entries()]
  );
  const beforeUpset = eloDiagnostic(context, toModelFixture(target));
  const afterUpsetContext = createPreMatchContext(
    match(21, "2026-01-12T12:00:00Z", 1, 2, 0, 1),
    [...history, target]
  );
  const afterUpset = eloDiagnostic(afterUpsetContext, toModelFixture(target));
  assert.notEqual(beforeUpset.homeRating, afterUpset.homeRating);
}

function testShrinkageTendsTowardLeagueAverage() {
  const shrunk = shrinkRate(4, 1, 1.2, 8);
  assert.ok(shrunk < 4);
  assert.ok(shrunk > 1.2);
  assert.equal(shrinkRate(4, 0, 1.2, 8), 1.2);
}

function testFormAdjustmentCapped() {
  const context = createPreMatchContext(target, history);
  const form = formLambdaFactors(context, toModelFixture(target), { cap: 0.08 });
  assert.ok(Math.abs(form.effect) <= 0.08);
}

function testChallengerProbabilityRangesAndDeterminism() {
  const context = createPreMatchContext(target, history);
  const fixture = toModelFixture(target);
  for (const variant of Object.values(CHALLENGER_VARIANTS)) {
    const first = buildChallengerModel(fixture, context, variant);
    const second = buildChallengerModel(fixture, context, variant);
    assert.deepEqual(first.model, second.model);
    const sum = first.model.home + first.model.draw + first.model.away;
    assert.ok(Math.abs(sum - 1) < 1e-12);
    assert.ok([first.model.home, first.model.draw, first.model.away].every(value => value >= 0 && value <= 1));
  }
}

testPoissonProbabilitiesSumToOne();
testScoreMatrixDeterministic();
testNoFutureData();
testEloOnlyUpdatesChronologically();
testShrinkageTendsTowardLeagueAverage();
testFormAdjustmentCapped();
testChallengerProbabilityRangesAndDeterminism();

console.log("Stage 4 tests OK: challenger Poisson, Elo, shrinkage, form and determinism.");
