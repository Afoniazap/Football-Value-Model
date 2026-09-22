// Two baselines to compare V3 (full DC) against, per spec:
//  1) naive league/home-frequency -- constant per-league H/D/A from training data
//  2) independent Poisson -- the SAME log-linear attack/defence model, rho
//     fixed at 0 (tau===1 everywhere), never estimated. Reuses model.js/
//     optimizer.js directly so the comparison isolates exactly the DC
//     low-score correction's effect, nothing else.
import { fitLinearParams } from "./optimizer.js";
import { matchLambdas } from "./model.js";
import { buildScoreMatrix, aggregate1X2 } from "./scoreMatrix.js";
import { initParams } from "./params.js";

export function fitNaiveBaseline(trainMatches) {
  const byLeague = new Map();
  for (const m of trainMatches) {
    if (!byLeague.has(m.league)) byLeague.set(m.league, { home: 0, draw: 0, away: 0, total: 0 });
    const g = byLeague.get(m.league);
    g.total++;
    if (m.homeGoals > m.awayGoals) g.home++; else if (m.homeGoals < m.awayGoals) g.away++; else g.draw++;
  }
  const probsByLeague = new Map();
  for (const [league, g] of byLeague) probsByLeague.set(league, { home: g.home / g.total, draw: g.draw / g.total, away: g.away / g.total });
  return {
    predict(match) {
      return probsByLeague.get(match.league) ?? { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
    }
  };
}

export function fitIndependentPoisson(index, trainMatches, weights, priorVariance, options) {
  const fit = fitLinearParams(initParams(index), index, trainMatches, weights, 0, priorVariance, options);
  return {
    fit,
    predict(match) {
      const { lambdaHome, lambdaAway } = matchLambdas(fit.params, index, match);
      const { matrix, n } = buildScoreMatrix(lambdaHome, lambdaAway, 0);
      return aggregate1X2(matrix, n);
    }
  };
}
