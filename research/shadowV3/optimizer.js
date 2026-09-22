// Deterministic full-batch gradient descent with Armijo backtracking line
// search. No external dependency (see the Phase-1 report for why: problem
// size here is small -- a few hundred parameters, a few thousand weighted
// matches per fold -- full-batch gradients are cheap, and the objective is
// convex for fixed rho, so plain gradient descent with a proper line search
// converges reliably without needing a Hessian or a third-party solver).
// Reproducible: same inputs -> same iteration trace, no randomness anywhere.
import { objectiveAndGradient } from "./model.js";
import { reproject } from "./params.js";

function cloneParams(p) {
  return { mu: p.mu.slice(), ha: p.ha.slice(), attack: p.attack.slice(), defence: p.defence.slice(), rho: p.rho };
}
function gradNorm(grad) {
  let s = 0;
  for (const arr of [grad.mu, grad.ha, grad.attack, grad.defence]) for (const v of arr) s += v * v;
  return Math.sqrt(s);
}
function axpy(target, source, step) { // target += step * source, in place
  for (let i = 0; i < target.length; i++) target[i] += step * source[i];
}

/**
 * Fits (mu, ha, attack, defence) for a FIXED rho via gradient descent.
 * Returns {params, history, converged, reason, iterations}. Never returns a
 * "converged" model silently on failure/divergence/NaN -- callers must
 * check `converged` and `reason` explicitly.
 */
export function fitLinearParams(initialParams, index, matches, weights, rho, priorVariance, options = {}) {
  // Defaults tuned against the real ~100-parameter, ~2000-3500 match walk-forward
  // folds: plain gradient descent's gradient norm decays very slowly near the
  // optimum (a known property, no curvature information), so a strict 1e-4
  // gradient tolerance / 1e-8 objective tolerance takes 1000+ iterations to
  // reach for a <0.01 NLL improvement over 200 iterations -- not worth the
  // wall-clock cost for this research prototype. Verified the NLL at
  // objTolerance=1e-6 is within 0.01 of the value at 1e-8 (5x fewer iterations).
  const maxIterations = options.maxIterations ?? 1500;
  const gradTolerance = options.gradTolerance ?? 1e-2;
  const objTolerance = options.objTolerance ?? 1e-6;
  let params = cloneParams(initialParams);
  params.rho = rho;
  reproject(params, index);

  let { nll, grad, infeasible } = objectiveAndGradient(params, index, matches, weights, rho, priorVariance);
  if (infeasible) return { params, history: [], converged: false, reason: "initial parameters infeasible for this rho", iterations: 0 };

  const history = [{ iteration: 0, nll, gradNorm: gradNorm(grad) }];
  let stepSize = 1.0;

  for (let iter = 1; iter <= maxIterations; iter++) {
    const gn = gradNorm(grad);
    if (gn < gradTolerance) return { params, history, converged: true, reason: "gradient norm below tolerance", iterations: iter - 1 };

    // Backtracking line search (Armijo): try the last successful step size
    // first (usually still good), halve on failure, cap attempts.
    let accepted = false, trialStep = stepSize * 1.5, trial, trialNll;
    for (let attempt = 0; attempt < 40; attempt++) {
      trial = cloneParams(params);
      axpy(trial.mu, grad.mu, -trialStep);
      axpy(trial.ha, grad.ha, -trialStep);
      axpy(trial.attack, grad.attack, -trialStep);
      axpy(trial.defence, grad.defence, -trialStep);
      reproject(trial, index);
      const evaluated = objectiveAndGradient(trial, index, matches, weights, rho, priorVariance);
      if (!evaluated.infeasible && Number.isFinite(evaluated.nll) && evaluated.nll <= nll - 1e-12 * trialStep * gn * gn) {
        trialNll = evaluated.nll; accepted = true;
        params = trial; grad = evaluated.grad; nll = evaluated.nll;
        stepSize = trialStep;
        break;
      }
      trialStep *= 0.5;
    }
    if (!accepted) return { params, history, converged: false, reason: "line search failed to find a decreasing step (likely near a flat/degenerate region)", iterations: iter - 1 };

    history.push({ iteration: iter, nll, gradNorm: gradNorm(grad), stepSize });
    if (history.length >= 2) {
      const prevNll = history[history.length - 2].nll;
      if (Math.abs(prevNll - nll) < objTolerance) return { params, history, converged: true, reason: "objective change below tolerance", iterations: iter };
    }
  }
  return { params, history, converged: false, reason: `reached maxIterations=${maxIterations} without meeting tolerance`, iterations: maxIterations };
}
