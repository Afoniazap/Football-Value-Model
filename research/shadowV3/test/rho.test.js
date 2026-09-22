import { test } from "node:test";
import assert from "node:assert/strict";
import { tau, feasibleRhoRange, matchLambdas } from "../model.js";
import { buildParamIndex, initParams } from "../params.js";
import { fitRho } from "../rho.js";
import { makeSyntheticMatches, uniformWeights } from "./fixtures.js";

test("feasibleRhoRange guarantees tau>=0 on all 4 special cells, at every match's own lambda, for any rho inside the range", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  for (let i = 0; i < params.attack.length; i++) { params.attack[i] = Math.sin(i) * 0.5; params.defence[i] = Math.cos(i) * 0.5; }
  const { lower, upper } = feasibleRhoRange(params, index, matches);
  assert.ok(upper > lower);
  for (const rho of [lower, upper, (lower + upper) / 2]) {
    for (const m of matches) {
      const { lambdaHome, lambdaAway } = matchLambdas(params, index, m);
      const cells = [tau(0, 0, lambdaHome, lambdaAway, rho), tau(0, 1, lambdaHome, lambdaAway, rho), tau(1, 0, lambdaHome, lambdaAway, rho), tau(1, 1, lambdaHome, lambdaAway, rho)];
      assert.ok(cells.every(c => c >= -1e-9), `rho=${rho} lh=${lambdaHome} la=${lambdaAway} cells=${cells}`);
    }
  }
});

test("a rho fixed at a literature-style -0.15 constant is NOT always feasible (motivates data-dependent range)", () => {
  // At large enough lambda, tau(1,1) = 1-rho stays fine, but tau(0,0) =
  // 1 - lambdaHome*lambdaAway*rho goes negative for rho<0 only if rho>0; the
  // real failure mode is on the POSITIVE side: tau(0,0) needs rho <= 1/(lh*la).
  const lh = 3.4, la = 3.1;
  const rho = 0.15; // deliberately outside the commonly-cited [-0.15,0] window, positive side
  const t00 = tau(0, 0, lh, la, rho);
  assert.ok(t00 < 0, "expected the naive fixed-window rho to be infeasible at this lambda -- proves the range must be data-dependent");
});

test("fitRho only ever returns a rho within the feasible range it computed", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const weights = uniformWeights(matches);
  const result = fitRho(initParams(index), index, matches, weights, 1, { maxIterations: 200 });
  assert.ok(result.converged);
  assert.ok(result.rho >= result.feasibleRange.lower - 1e-6);
  assert.ok(result.rho <= result.feasibleRange.upper + 1e-6);
});
