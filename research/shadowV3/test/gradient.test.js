// The highest-risk test in Phase 1: model.js's gradient was hand-derived via
// the chain rule (including the DC tau special cases at (0,0)/(0,1)/(1,0)/(1,1))
// and never independently verified before this test existed. Central finite
// differences on every scalar parameter must match the analytic gradient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildParamIndex, initParams } from "../params.js";
import { objectiveAndGradient } from "../model.js";
import { makeSyntheticMatches, uniformWeights } from "./fixtures.js";

function cloneParams(p) { return { mu: p.mu.slice(), ha: p.ha.slice(), attack: p.attack.slice(), defence: p.defence.slice(), rho: p.rho }; }

function numericalGradient(field, params, index, matches, weights, rho, priorVariance, eps = 1e-6) {
  const grad = new Float64Array(params[field].length);
  for (let i = 0; i < params[field].length; i++) {
    const plus = cloneParams(params); plus[field][i] += eps;
    const minus = cloneParams(params); minus[field][i] -= eps;
    const nllPlus = objectiveAndGradient(plus, index, matches, weights, rho, priorVariance).nll;
    const nllMinus = objectiveAndGradient(minus, index, matches, weights, rho, priorVariance).nll;
    grad[i] = (nllPlus - nllMinus) / (2 * eps);
  }
  return grad;
}

test("analytic gradient matches central finite differences on every parameter (rho=0, no prior)", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  // Perturb away from the all-zero starting point so we're not testing a
  // degenerate/symmetric special case.
  for (let i = 0; i < params.attack.length; i++) { params.attack[i] = Math.sin(i + 1) * 0.3; params.defence[i] = Math.cos(i + 1) * 0.3; }
  const weights = uniformWeights(matches);
  const rho = 0;
  const { grad } = objectiveAndGradient(params, index, matches, weights, rho, 0);
  for (const field of ["mu", "ha", "attack", "defence"]) {
    const numeric = numericalGradient(field, params, index, matches, weights, rho, 0);
    for (let i = 0; i < numeric.length; i++) {
      assert.ok(Math.abs(grad[field][i] - numeric[i]) < 1e-4, `${field}[${i}]: analytic=${grad[field][i]} numeric=${numeric[i]}`);
    }
  }
});

test("analytic gradient matches finite differences with a nonzero rho (exercises tau special cases)", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  for (let i = 0; i < params.attack.length; i++) { params.attack[i] = Math.sin(i + 1) * 0.3; params.defence[i] = Math.cos(i + 1) * 0.3; }
  const weights = uniformWeights(matches);
  const rho = 0.05; // small, stays feasible for these lambdas (see feasibleRhoRange)
  const { grad, infeasible } = objectiveAndGradient(params, index, matches, weights, rho, 0);
  assert.equal(infeasible, false);
  for (const field of ["mu", "ha", "attack", "defence"]) {
    const numeric = numericalGradient(field, params, index, matches, weights, rho, 0);
    for (let i = 0; i < numeric.length; i++) {
      assert.ok(Math.abs(grad[field][i] - numeric[i]) < 1e-4, `${field}[${i}]: analytic=${grad[field][i]} numeric=${numeric[i]}`);
    }
  }
});

test("analytic gradient includes the L2 prior term correctly (attack/defence only)", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  for (let i = 0; i < params.attack.length; i++) { params.attack[i] = 0.5; params.defence[i] = -0.3; }
  const weights = uniformWeights(matches);
  const priorVariance = 0.5;
  const { grad } = objectiveAndGradient(params, index, matches, weights, 0, priorVariance);
  const numericAttack = numericalGradient("attack", params, index, matches, weights, 0, priorVariance);
  const numericMu = numericalGradient("mu", params, index, matches, weights, 0, priorVariance);
  for (let i = 0; i < numericAttack.length; i++) assert.ok(Math.abs(grad.attack[i] - numericAttack[i]) < 1e-4);
  for (let i = 0; i < numericMu.length; i++) assert.ok(Math.abs(grad.mu[i] - numericMu[i]) < 1e-4);
});
