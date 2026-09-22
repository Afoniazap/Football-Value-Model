// rho is a single scalar (nuisance parameter for the low-score correction),
// fit by profile-likelihood: for a grid of candidate rho values inside the
// DATA-DEPENDENT feasible range (model.js's feasibleRhoRange, not a fixed
// [-0.15,0] literature constant), refit the linear parameters and keep the
// rho with the lowest training NLL. This is standard Dixon-Coles practice
// (rho is estimated on training data via MLE, not tuned on a validation
// fold -- only halfLife and priorVariance are true hyperparameters, see
// walkforward.js).
import { feasibleRhoRange, objectiveAndGradient } from "./model.js";
import { fitLinearParams } from "./optimizer.js";

export function fitRho(initialParams, index, matches, weights, priorVariance, options = {}) {
  const gridSize = options.gridSize ?? 13;

  // First pass: fit at rho=0 to get realistic lambdas for the feasibility bound.
  const zeroFit = fitLinearParams(initialParams, index, matches, weights, 0, priorVariance, options);
  if (!zeroFit.converged) return { rho: 0, fit: zeroFit, converged: false, reason: `rho=0 baseline fit did not converge: ${zeroFit.reason}`, grid: [] };

  const { lower, upper } = feasibleRhoRange(zeroFit.params, index, matches);
  if (!(upper > lower)) return { rho: 0, fit: zeroFit, converged: false, reason: `infeasible rho range [${lower},${upper}]`, grid: [] };

  // Grid search within the feasible range, refitting linear params at each
  // candidate (alternating-optimization / profile likelihood).
  const grid = [];
  let best = { rho: 0, nll: zeroFit.history.at(-1).nll, fit: zeroFit };
  for (let i = 0; i < gridSize; i++) {
    const t = i / (gridSize - 1);
    const candidate = lower + t * (upper - lower);
    // Keep a small margin off the exact boundary -- tau==0 exactly is a
    // measure-zero degenerate point, not a useful evaluation target.
    const rho = Math.max(lower + 1e-6, Math.min(upper - 1e-6, candidate));
    const fit = fitLinearParams(zeroFit.params, index, matches, weights, rho, priorVariance, options);
    const nll = fit.converged ? fit.history.at(-1).nll : Infinity;
    grid.push({ rho, nll, converged: fit.converged, reason: fit.reason });
    if (fit.converged && nll < best.nll) best = { rho, nll, fit };
  }

  return { rho: best.rho, fit: best.fit, converged: true, reason: "profile likelihood grid search over feasible rho range", grid, feasibleRange: { lower, upper } };
}
