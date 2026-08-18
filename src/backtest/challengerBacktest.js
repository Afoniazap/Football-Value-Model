import { buildModel } from "../model/probability.js";
import {
  createPreMatchContext,
  rejectionReason,
  toModelFixture
} from "../historical/featureSnapshot.js";
import {
  buildChallengerModel,
  CHALLENGER_VARIANTS
} from "../model/challenger/probability.js";
import { calibrationReport } from "./calibration.js";
import { extremeProbabilityReport } from "./extremeAudit.js";
import { summarizeBacktest, logLoss, multiclassBrier, predictedResult } from "./metrics.js";
import { calibratedPredictions, fitTemperature } from "../model/challenger/calibration.js";

function teamHistoryCount(context, teamId) {
  return (context.matches || [])
    .filter(item => item.homeTeam?.id === teamId || item.awayTeam?.id === teamId)
    .length;
}

function orderedMatches(matches) {
  return [...matches].sort((a, b) => {
    const timeDiff = new Date(a.utcDate) - new Date(b.utcDate);
    if (timeDiff) return timeDiff;
    return String(a.fixtureId).localeCompare(String(b.fixtureId));
  });
}

function predictionRow(match, context, modelled, label) {
  return {
    fixtureId: match.fixtureId,
    competition: match.competition,
    competitionCode: match.competitionCode,
    season: match.season,
    utcDate: match.utcDate,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    actualResult: match.result,
    modelLabel: label,
    model: modelled.model,
    dataQuality: modelled.dataQuality ?? null,
    snapshotMeta: {
      ...context.meta,
      teamHistory: {
        home: teamHistoryCount(context, match.homeTeamId),
        away: teamHistoryCount(context, match.awayTeamId)
      },
      teamHistoryMin: Math.min(
        teamHistoryCount(context, match.homeTeamId),
        teamHistoryCount(context, match.awayTeamId)
      )
    }
  };
}

export function buildPredictionDataset(matches, options = {}) {
  const minimumPriorMatches = options.minimumPriorMatches ?? 5;
  const ordered = orderedMatches(matches);
  const rows = [];
  const rejected = [];

  for (const match of ordered) {
    const context = createPreMatchContext(match, ordered);
    const reason = rejectionReason(match, context, minimumPriorMatches);
    if (reason) {
      rejected.push({ fixtureId: match.fixtureId, reason });
      continue;
    }

    const fixture = toModelFixture(match);
    const baseline = buildModel(fixture, context);
    if (!baseline.model) {
      rejected.push({ fixtureId: match.fixtureId, reason: baseline.reason || "BASELINE_UNAVAILABLE" });
      continue;
    }

    rows.push({
      match,
      context,
      fixture,
      baseline: predictionRow(match, context, baseline, "BASELINE")
    });
  }

  return { rows, rejected };
}

export function chronologicalSplit(predictions, developmentRatio = 0.7) {
  const rows = orderedMatches(predictions);
  const splitAt = Math.max(1, Math.floor(rows.length * developmentRatio));
  return {
    development: rows.slice(0, splitAt),
    validation: rows.slice(splitAt)
  };
}

function drawDiagnostics(predictions) {
  const usable = predictions.filter(item => item.model);
  const drawRows = usable.filter(item => item.actualResult === "D");
  const drawTopPicks = usable.filter(item => predictedResult(item.model) === "D").length;
  return {
    actualDrawRate: usable.length ? drawRows.length / usable.length : null,
    meanPredictedDraw: usable.length
      ? usable.reduce((sum, item) => sum + item.model.draw, 0) / usable.length
      : null,
    drawTopPicks,
    drawBrier: usable.length
      ? usable.reduce((sum, item) => sum + ((item.model.draw - (item.actualResult === "D" ? 1 : 0)) ** 2), 0) / usable.length
      : null,
    drawLogLoss: drawRows.length
      ? drawRows.reduce((sum, item) => sum + logLoss(item.model, "D"), 0) / drawRows.length
      : null
  };
}

function metricPack(predictions) {
  const metrics = summarizeBacktest(predictions);
  const calibration = calibrationReport(predictions);
  return {
    sample: metrics.sampleSize,
    accuracy: metrics.accuracy,
    brier: metrics.brier,
    logLoss: metrics.logLoss,
    ece: calibration.expectedCalibrationError,
    draw: drawDiagnostics(predictions),
    actualDistribution: metrics.actualDistribution,
    predictedDistribution: metrics.predictedDistribution,
    highProbabilityPerformance: metrics.highProbabilityPerformance,
    probabilityDistribution: metrics.distribution,
    calibration
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function diffCorrelation(predictions, componentA, componentB, probabilityKey) {
  const pairs = predictions
    .map(item => [
      (item.model.components?.[componentA] ?? 0) - (item.model.components?.[componentB] ?? 0),
      item.model[probabilityKey]
    ])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return null;
  const meanX = average(pairs.map(([x]) => x));
  const meanY = average(pairs.map(([, y]) => y));
  const numerator = pairs.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denomX = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0));
  const denomY = Math.sqrt(pairs.reduce((sum, [, y]) => sum + (y - meanY) ** 2, 0));
  return denomX && denomY ? numerator / (denomX * denomY) : null;
}

function seasonMaturity(predictions) {
  const groups = {
    matches5to9: predictions.filter(item => item.snapshotMeta.teamHistoryMin >= 5 && item.snapshotMeta.teamHistoryMin <= 9),
    matches10to19: predictions.filter(item => item.snapshotMeta.teamHistoryMin >= 10 && item.snapshotMeta.teamHistoryMin <= 19),
    matches20plus: predictions.filter(item => item.snapshotMeta.teamHistoryMin >= 20)
  };
  return Object.fromEntries(Object.entries(groups).map(([key, rows]) => {
    const metrics = summarizeBacktest(rows);
    return [key, {
      sample: metrics.sampleSize,
      accuracy: metrics.accuracy,
      brier: metrics.brier,
      logLoss: metrics.logLoss
    }];
  }));
}

function selectBestRaw(results) {
  return [...results].sort((a, b) => {
    return (a.development.logLoss - b.development.logLoss) ||
      (a.development.brier - b.development.brier) ||
      (a.development.ece - b.development.ece);
  })[0];
}

export function runChallengerExperiment(matches, options = {}) {
  const dataset = buildPredictionDataset(matches, options);
  const basePredictions = dataset.rows.map(row => row.baseline);
  const baselineSplit = chronologicalSplit(basePredictions, options.developmentRatio ?? 0.7);
  const baseline = {
    label: "BASELINE_MODEL_V04",
    development: metricPack(baselineSplit.development),
    validation: metricPack(baselineSplit.validation),
    validationExtreme: extremeProbabilityReport(baselineSplit.validation)
  };

  const variants = Object.values(CHALLENGER_VARIANTS).map(variant => {
    const predictions = dataset.rows.map(row => {
      const modelled = buildChallengerModel(row.fixture, row.context, variant);
      return predictionRow(row.match, row.context, modelled, variant.key);
    });
    const split = chronologicalSplit(predictions, options.developmentRatio ?? 0.7);
    return {
      label: variant.key,
      development: metricPack(split.development),
      validation: metricPack(split.validation),
      developmentPredictions: split.development,
      validationPredictions: split.validation,
      validationExtreme: extremeProbabilityReport(split.validation),
      featureDiagnostics: {
        lambdaDiffVsHomeProbability: diffCorrelation(split.validation, "lambdaHome", "lambdaAway", "home"),
        attackDefenseDiffVsHomeProbability: diffCorrelation(split.validation, "homeAttack", "awayAttack", "home"),
        seasonMaturity: seasonMaturity(split.validation)
      }
    };
  });

  const bestRaw = selectBestRaw(variants);
  const temperature = fitTemperature(bestRaw.developmentPredictions);
  const calibratedDevelopment = calibratedPredictions(bestRaw.developmentPredictions, temperature.temperature);
  const calibratedValidation = calibratedPredictions(bestRaw.validationPredictions, temperature.temperature);
  const bestCalibrated = {
    label: `${bestRaw.label}+TEMP`,
    temperature,
    development: metricPack(calibratedDevelopment),
    validation: metricPack(calibratedValidation),
    validationExtreme: extremeProbabilityReport(calibratedValidation),
    validationPredictions: calibratedValidation
  };

  return {
    coverage: {
      matchesAvailable: matches.length,
      matchesUsable: basePredictions.length,
      matchesRejected: dataset.rejected.length,
      rejectedReasons: dataset.rejected.reduce((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {}),
      competitions: [...new Set(matches.map(match => match.competitionCode).filter(Boolean))],
      seasons: [...new Set(matches.map(match => match.season).filter(Boolean))]
    },
    baseline,
    variants,
    bestRaw: {
      label: bestRaw.label,
      development: bestRaw.development,
      validation: bestRaw.validation,
      featureDiagnostics: bestRaw.featureDiagnostics
    },
    bestCalibrated,
    selectionPolicy: "Best raw selected on development only by logLoss, then Brier, then ECE. Temperature fitted on development only."
  };
}
