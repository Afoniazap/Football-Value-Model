// Regression test for a real bug found while running the actual walk-forward
// experiment: a validation/test-season team absent from the training index
// (promotion/relegation between seasons -- routine every year) used to
// produce NaN lambdas (params.attack[undefined]), which silently NaN'd every
// downstream logLoss and made the entire tuning grid look non-convergent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildParamIndex, initParams } from "../params.js";
import { matchLambdas } from "../model.js";
import { makeSyntheticMatches } from "./fixtures.js";

test("matchLambdas falls back to league-average (attack=0, defence=0) for a team absent from the index, instead of NaN", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches); // only knows teams A, B, C, D
  const params = initParams(index);
  for (let i = 0; i < params.attack.length; i++) { params.attack[i] = 0.4; params.defence[i] = -0.2; }

  const promotedTeamMatch = { league: "T", home: "A", away: "NEWLY_PROMOTED_TEAM" };
  const { lambdaHome, lambdaAway } = matchLambdas(params, index, promotedTeamMatch);
  assert.ok(Number.isFinite(lambdaHome));
  assert.ok(Number.isFinite(lambdaAway));

  // Away team uses attack=0, defence=0 -- verify against the explicit formula.
  const li = index.leagueIndex.get("T");
  const expectedLogLh = params.mu[li] + params.ha[li] + params.attack[index.teamIndex.get("T|A")] - 0;
  const expectedLogLa = params.mu[li] + 0 - params.defence[index.teamIndex.get("T|A")];
  assert.ok(Math.abs(lambdaHome - Math.exp(expectedLogLh)) < 1e-12);
  assert.ok(Math.abs(lambdaAway - Math.exp(expectedLogLa)) < 1e-12);
});

test("matchLambdas handles both teams being absent from the index (two newly-promoted sides meeting)", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  const { lambdaHome, lambdaAway } = matchLambdas(params, index, { league: "T", home: "NEW_A", away: "NEW_B" });
  assert.ok(Number.isFinite(lambdaHome) && lambdaHome > 0);
  assert.ok(Number.isFinite(lambdaAway) && lambdaAway > 0);
});
