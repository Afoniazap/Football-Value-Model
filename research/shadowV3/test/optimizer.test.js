import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLinearParams } from "../optimizer.js";
import { buildParamIndex, initParams } from "../params.js";
import { makeSyntheticMatches, uniformWeights } from "./fixtures.js";

test("converges on a well-posed synthetic problem and reports gradient-norm-below-tolerance", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const result = fitLinearParams(initParams(index), index, matches, uniformWeights(matches), 0, 1, { maxIterations: 500 });
  assert.equal(result.converged, true);
  assert.match(result.reason, /gradient norm|objective change/);
});

test("is deterministic: identical inputs produce an identical iteration trace and final params", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const weights = uniformWeights(matches);
  const r1 = fitLinearParams(initParams(index), index, matches, weights, 0.05, 1, { maxIterations: 300 });
  const r2 = fitLinearParams(initParams(index), index, matches, weights, 0.05, 1, { maxIterations: 300 });
  assert.equal(r1.iterations, r2.iterations);
  assert.deepEqual([...r1.params.attack], [...r2.params.attack]);
  assert.deepEqual([...r1.params.defence], [...r2.params.defence]);
  assert.deepEqual(r1.history.map(h => h.nll), r2.history.map(h => h.nll));
});

test("reports a non-converged failure, never a silently-accepted bad model, when rho is infeasible for the starting params", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  // rho=1.5 is outside any valid range (tau(1,1)=1-rho<0) -- must fail cleanly.
  const result = fitLinearParams(initParams(index), index, matches, uniformWeights(matches), 1.5, 1, { maxIterations: 50 });
  assert.equal(result.converged, false);
  assert.ok(result.reason.length > 0);
});
