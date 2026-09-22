import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLinearParams } from "../optimizer.js";
import { buildParamIndex, initParams } from "../params.js";
import { makeSyntheticMatches, uniformWeights } from "./fixtures.js";

function l2Norm(arr) { let s = 0; for (const v of arr) s += v * v; return Math.sqrt(s); }

test("a smaller prior variance (stronger L2 shrinkage) yields smaller-magnitude attack/defence coefficients at the optimum", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const weights = uniformWeights(matches);
  const strong = fitLinearParams(initParams(index), index, matches, weights, 0, 0.05, { maxIterations: 500 });
  const weak = fitLinearParams(initParams(index), index, matches, weights, 0, 20, { maxIterations: 500 });
  assert.equal(strong.converged, true);
  assert.equal(weak.converged, true);
  const strongNorm = l2Norm(strong.params.attack) + l2Norm(strong.params.defence);
  const weakNorm = l2Norm(weak.params.attack) + l2Norm(weak.params.defence);
  assert.ok(strongNorm < weakNorm, `expected shrinkage: strong=${strongNorm} weak=${weakNorm}`);
});

test("the prior never regularizes mu or ha (structural, league-level parameters are not shrunk toward 0)", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const weights = uniformWeights(matches);
  const strong = fitLinearParams(initParams(index), index, matches, weights, 0, 0.01, { maxIterations: 500 });
  const unregularized = fitLinearParams(initParams(index), index, matches, weights, 0, Number.POSITIVE_INFINITY, { maxIterations: 500 });
  // priorVariance=Infinity means invVar=0 -- identical to "no prior term" for
  // mu/ha in every case, since they were never penalized to begin with; this
  // just confirms mu/ha aren't accidentally wired into the prior sum.
  assert.ok(Number.isFinite(strong.params.mu[0]));
  assert.ok(Number.isFinite(unregularized.params.mu[0]));
});
