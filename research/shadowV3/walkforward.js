// Walk-forward protocol, Phase 1 -- exact folds per spec:
//   Tuning fold A: train 2023/24            -> validate 2024/25
//   Tuning fold B: train 2023/24+2024/25    -> validate 2025/26
//   Final test (untouched, run ONCE):
//                  train 2023/24+2024/25+2025/26 -> test 2026/27
// halfLife/priorVariance are tuned ONLY on folds A/B. rho is never a tuned
// hyperparameter -- it is refit via MLE (rho.js) inside every fold, train-only.
//
// Season boundaries are derived from kickoff TIMESTAMPS (season-start = 1
// July UTC), never from the raw `season` text column -- the readiness audit
// found that column inconsistently formatted (full date string vs bare year)
// depending on import path, so it cannot safely define a leakage boundary.
import { beforeCutoff, betweenCutoffs } from "./dataset.js";
import { decayWeight, HALF_LIFE_CANDIDATES } from "./decay.js";
import { buildParamIndex, initParams } from "./params.js";
import { fitRho } from "./rho.js";
import { matchLambdas } from "./model.js";
import { buildScoreMatrix, aggregate1X2 } from "./scoreMatrix.js";
import { fitNaiveBaseline, fitIndependentPoisson } from "./baselines.js";
import { logLoss, brierScore, breakdownByOutcome, calibrationBins } from "./metrics.js";

const SEASON_START_MONTH = 6; // July, 0-indexed -- European domestic season convention

export function seasonStartMs(year) { return Date.UTC(year, SEASON_START_MONTH, 1); }

export function buildFolds(matches) {
  return {
    tuningA: {
      label: "2023/24 -> validate 2024/25",
      train: betweenCutoffs(matches, seasonStartMs(2023), seasonStartMs(2024)),
      validation: betweenCutoffs(matches, seasonStartMs(2024), seasonStartMs(2025)),
      cutoffMs: seasonStartMs(2024)
    },
    tuningB: {
      label: "2023/24+2024/25 -> validate 2025/26",
      train: betweenCutoffs(matches, seasonStartMs(2023), seasonStartMs(2025)),
      validation: betweenCutoffs(matches, seasonStartMs(2025), seasonStartMs(2026)),
      cutoffMs: seasonStartMs(2025)
    },
    finalTest: {
      label: "2023/24+2024/25+2025/26 -> UNTOUCHED test 2026/27",
      train: betweenCutoffs(matches, seasonStartMs(2023), seasonStartMs(2026)),
      validation: beforeCutoff(matches, Infinity).filter(m => m.kickoffMs >= seasonStartMs(2026)),
      cutoffMs: seasonStartMs(2026)
    }
  };
}

function weightsFor(trainMatches, cutoffMs, halfLife) {
  return trainMatches.map(m => decayWeight(m.kickoffMs, cutoffMs, halfLife));
}

function predictAll(predictFn, matches) { return matches.map(m => predictFn(m)); }

/** Fits DC on `train` (weighted by halfLife, relative to cutoffMs), evaluates on `validation`. */
export function runFold(train, validation, cutoffMs, halfLife, priorVariance, options = {}) {
  const index = buildParamIndex(train);
  const weights = weightsFor(train, cutoffMs, halfLife);
  const rhoResult = fitRho(initParams(index), index, train, weights, priorVariance, options);
  if (!rhoResult.converged) {
    return { halfLife, priorVariance, converged: false, reason: rhoResult.reason, logLoss: Infinity, brier: Infinity };
  }
  const predictions = predictAll(m => {
    const { lambdaHome, lambdaAway } = matchLambdas(rhoResult.fit.params, index, m);
    const { matrix, n } = buildScoreMatrix(lambdaHome, lambdaAway, rhoResult.rho);
    return aggregate1X2(matrix, n);
  }, validation);
  return {
    halfLife, priorVariance, converged: true,
    rho: rhoResult.rho, rhoGridPoints: rhoResult.grid.length, rhoFeasibleRange: rhoResult.feasibleRange,
    trainMatches: train.length, validationMatches: validation.length,
    logLoss: logLoss(predictions, validation),
    brier: brierScore(predictions, validation),
    iterations: rhoResult.fit.iterations,
    finalGradNorm: rhoResult.fit.history.at(-1)?.gradNorm,
    fitReason: rhoResult.fit.reason,
    predictions,
    index, params: rhoResult.fit.params, rhoFitReason: rhoResult.reason
  };
}

/**
 * Grid search over halfLife x priorVariance using ONLY folds A and B (never
 * finalTest). Score per combo = mean logLoss across the two validation folds
 * (both must converge; a non-converging combo is scored Infinity, never
 * silently skipped). Returns the argmin combo plus the full grid for the report.
 */
export function tuneHyperparameters(folds, options = {}) {
  const priorVarianceGrid = options.priorVarianceGrid ?? [0.05, 0.1, 0.25, 0.5, 1, 2, 5];
  const halfLifeGrid = options.halfLifeGrid ?? HALF_LIFE_CANDIDATES;
  const grid = [];
  let best = null;
  for (const halfLife of halfLifeGrid) {
    for (const priorVariance of priorVarianceGrid) {
      const a = runFold(folds.tuningA.train, folds.tuningA.validation, folds.tuningA.cutoffMs, halfLife, priorVariance, options);
      const b = runFold(folds.tuningB.train, folds.tuningB.validation, folds.tuningB.cutoffMs, halfLife, priorVariance, options);
      const score = a.converged && b.converged ? (a.logLoss + b.logLoss) / 2 : Infinity;
      const entry = {
        halfLife, priorVariance, score,
        foldA: { logLoss: a.logLoss, brier: a.brier, converged: a.converged, reason: a.reason ?? a.fitReason, iterations: a.iterations, rho: a.rho },
        foldB: { logLoss: b.logLoss, brier: b.brier, converged: b.converged, reason: b.reason ?? b.fitReason, iterations: b.iterations, rho: b.rho }
      };
      grid.push(entry);
      if (!best || score < best.score) best = entry;
    }
  }
  if (!Number.isFinite(best.score)) {
    throw new Error(`hyperparameter tuning: no combo converged on both tuning folds -- grid: ${JSON.stringify(grid)}`);
  }
  return { chosen: { halfLife: best.halfLife, priorVariance: best.priorVariance }, grid, best };
}

/**
 * Runs the SINGLE untouched final test on 2026/27, using hyperparameters
 * that must already be frozen from tuneHyperparameters (caller's
 * responsibility -- this function does not look at any validation score to
 * pick anything, it just fits once and evaluates once).
 */
export function runFinalTest(folds, chosen, options = {}) {
  const { train, validation: test, cutoffMs } = folds.finalTest;
  const dc = runFold(train, test, cutoffMs, chosen.halfLife, chosen.priorVariance, options);
  if (!dc.converged) throw new Error(`final DC fit did not converge: ${dc.reason}`);

  const naive = fitNaiveBaseline(train);
  const naivePredictions = predictAll(m => naive.predict(m), test);

  const weights = weightsFor(train, cutoffMs, chosen.halfLife);
  const poisson = fitIndependentPoisson(dc.index, train, weights, chosen.priorVariance, options);
  if (!poisson.fit.converged) throw new Error(`final independent-Poisson fit did not converge: ${poisson.fit.reason}`);
  const poissonPredictions = predictAll(m => poisson.predict(m), test);

  const dcPredictions = dc.predictions; // runFold already evaluated on `test` (=finalTest.validation)
  const dcLambdaPairs = test.map(m => matchLambdas(dc.params, dc.index, m));
  const poissonLambdaPairs = test.map(m => matchLambdas(poisson.fit.params, dc.index, m));

  const summarize = (predictions) => ({
    logLoss: logLoss(predictions, test),
    brier: brierScore(predictions, test),
    breakdown: breakdownByOutcome(predictions, test),
    calibration: calibrationBins(predictions, test)
  });

  return {
    testMatches: test.length,
    train, test,
    chosen,
    rho: dc.rho,
    dcFit: { iterations: dc.iterations, finalGradNorm: dc.finalGradNorm, reason: dc.fitReason, rhoGridPoints: dc.rhoGridPoints, rhoFeasibleRange: dc.rhoFeasibleRange },
    poissonFit: { iterations: poisson.fit.iterations, finalGradNorm: poisson.fit.history.at(-1)?.gradNorm, reason: poisson.fit.reason },
    dcLambdaPairs, poissonLambdaPairs,
    dcPredictions, poissonPredictions, naivePredictions,
    naive: summarize(naivePredictions),
    independentPoisson: summarize(poissonPredictions),
    dixonColes: summarize(dcPredictions)
  };
}
