// Regularized log-linear Dixon-Coles: the objective (weighted DC negative
// log-likelihood + Gaussian L2 prior on attack/defence) and its exact
// analytic gradient. Verified against finite-difference gradients in
// model.test.js -- this is the one module where a silent sign error would
// be invisible without that check.
import { teamKey } from "./params.js";

/**
 * log lambda_home = mu[league] + ha[league] + attack[home] - defence[away]
 * log lambda_away = mu[league] + attack[away] - defence[home]
 *
 * A team absent from `index` (promoted/relegated between the training and
 * prediction seasons -- routine every season in every one of these 5
 * leagues) gets attack=0, defence=0: since reproject() pins mean(attack)
 * and mean(defence) to 0 per league at every fit, this is exactly "assume
 * league-average strength", not a silent zero/NaN. This only matters at
 * PREDICTION time -- during training every team is by construction already
 * in the index built from that same training set.
 */
function teamCoefficients(params, index, league, normalizedName) {
  const i = index.teamIndex.get(teamKey(league, normalizedName));
  return i === undefined ? { attack: 0, defence: 0 } : { attack: params.attack[i], defence: params.defence[i] };
}

export function matchLambdas(params, index, match) {
  const li = index.leagueIndex.get(match.league);
  const home = teamCoefficients(params, index, match.league, match.home);
  const away = teamCoefficients(params, index, match.league, match.away);
  const logLh = params.mu[li] + params.ha[li] + home.attack - away.defence;
  const logLa = params.mu[li] + away.attack - home.defence;
  return { lambdaHome: Math.exp(logLh), lambdaAway: Math.exp(logLa) };
}

// Dixon-Coles low-score correction. tau=1 everywhere except the 4 cells
// where independent-Poisson systematically mis-fits real football scores.
export function tau(x, y, lambdaHome, lambdaAway, rho) {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

const logFactorialCache = [0];
function logFactorial(k) {
  while (logFactorialCache.length <= k) logFactorialCache.push(logFactorialCache[logFactorialCache.length - 1] + Math.log(logFactorialCache.length));
  return logFactorialCache[k];
}

export function logPoissonPmf(k, lambda) { return k * Math.log(lambda) - lambda - logFactorial(k); }

/**
 * Weighted DC negative log-likelihood + exact gradient w.r.t. (mu, ha,
 * attack, defence), for a FIXED rho. `weights[i]` must line up 1:1 with
 * `matches[i]` (see decay.js). Returns `infeasible:true` (no gradient) if
 * rho makes tau<=0 anywhere in the batch -- callers must treat this as a
 * hard failure, never silently clamp and continue.
 */
export function objectiveAndGradient(params, index, matches, weights, rho, priorVariance) {
  const grad = {
    mu: new Float64Array(params.mu.length),
    ha: new Float64Array(params.ha.length),
    attack: new Float64Array(params.attack.length),
    defence: new Float64Array(params.defence.length)
  };
  let nll = 0;

  for (let m = 0; m < matches.length; m++) {
    const match = matches[m];
    const w = weights[m];
    const li = index.leagueIndex.get(match.league);
    const hi = index.teamIndex.get(teamKey(match.league, match.home));
    const ai = index.teamIndex.get(teamKey(match.league, match.away));

    const logLh = params.mu[li] + params.ha[li] + params.attack[hi] - params.defence[ai];
    const logLa = params.mu[li] + params.attack[ai] - params.defence[hi];
    const lh = Math.exp(logLh), la = Math.exp(logLa);

    const x = match.homeGoals, y = match.awayGoals;
    const t = tau(x, y, lh, la, rho);
    if (!(t > 0) || !Number.isFinite(lh) || !Number.isFinite(la)) return { nll: Infinity, grad: null, infeasible: true };

    const logP = Math.log(t) + logPoissonPmf(x, lh) + logPoissonPmf(y, la);
    nll -= w * logP;

    let dLogP_dLh = x / lh - 1;
    let dLogP_dLa = y / la - 1;
    if (x === 0 && y === 0) { dLogP_dLh += (-la * rho) / t; dLogP_dLa += (-lh * rho) / t; }
    else if (x === 0 && y === 1) { dLogP_dLh += rho / t; }
    else if (x === 1 && y === 0) { dLogP_dLa += rho / t; }

    const gLh = -w * (lh * dLogP_dLh); // d(NLL contribution)/d(logLambdaHome)
    const gLa = -w * (la * dLogP_dLa);

    grad.mu[li] += gLh + gLa;
    grad.ha[li] += gLh;
    grad.attack[hi] += gLh;
    grad.defence[ai] -= gLh;
    grad.attack[ai] += gLa;
    grad.defence[hi] -= gLa;
  }

  if (priorVariance > 0) {
    const invVar = 1 / priorVariance;
    for (let i = 0; i < params.attack.length; i++) {
      nll += 0.5 * invVar * params.attack[i] * params.attack[i];
      grad.attack[i] += invVar * params.attack[i];
      nll += 0.5 * invVar * params.defence[i] * params.defence[i];
      grad.defence[i] += invVar * params.defence[i];
    }
  }

  return { nll, grad, infeasible: false };
}

/**
 * Feasible rho range so tau>=0 on every one of the 4 low-score cells for
 * the WORST-CASE (max) lambdaHome/lambdaAway actually produced by the
 * current parameters on this match set -- data-dependent, not a fixed
 * literature constant. See rho.js for how this gets used.
 */
export function feasibleRhoRange(params, index, matches) {
  let maxLh = 0, maxLa = 0, maxProduct = 0;
  for (const match of matches) {
    const { lambdaHome, lambdaAway } = matchLambdas(params, index, match);
    if (lambdaHome > maxLh) maxLh = lambdaHome;
    if (lambdaAway > maxLa) maxLa = lambdaAway;
    if (lambdaHome * lambdaAway > maxProduct) maxProduct = lambdaHome * lambdaAway;
  }
  const lowerFrom01 = maxLh > 0 ? -1 / maxLh : -Infinity;
  const lowerFrom10 = maxLa > 0 ? -1 / maxLa : -Infinity;
  const lower = Math.max(lowerFrom01, lowerFrom10);
  const upperFrom00 = maxProduct > 0 ? 1 / maxProduct : Infinity;
  const upper = Math.min(1, upperFrom00);
  return { lower, upper };
}
