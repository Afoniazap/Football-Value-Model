import { summarizeBacktest } from "../backtest/metrics.js";
import { calibrationReport } from "../backtest/calibration.js";
import { buildPredictionDataset, chronologicalSplit } from "../backtest/challengerBacktest.js";
import { buildChallengerModel, CHALLENGER_VARIANTS } from "../model/challenger/probability.js";

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function pearson(pairs) {
  const usable = pairs.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (usable.length < 2) return null;
  const meanX = average(usable.map(([x]) => x));
  const meanY = average(usable.map(([, y]) => y));
  const numerator = usable.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denomX = Math.sqrt(usable.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0));
  const denomY = Math.sqrt(usable.reduce((sum, [, y]) => sum + (y - meanY) ** 2, 0));
  return denomX && denomY ? numerator / (denomX * denomY) : null;
}

function softmax(values) {
  const max = Math.max(...values);
  const exp = values.map(value => Math.exp(value - max));
  const sum = exp.reduce((acc, value) => acc + value, 0);
  return exp.map(value => value / sum);
}

function logit(probability) {
  return Math.log(Math.max(1e-12, probability));
}

export const XG_ABLATIONS = {
  CHALLENGER: { key: "challenger", useXg: false },
  XG: { key: "challenger+xG", useXg: true, fields: ["xGDiff"] },
  XG_XGA: { key: "challenger+xG/xGA", useXg: true, fields: ["xGDiff", "xGDefensiveStrength"] },
  NPXG: { key: "challenger+npxG", useXg: true, fields: ["npxGDiff"] },
  TREND: { key: "challenger+xGTrend", useXg: true, fields: ["xGTrend"] }
};

function xgSignal(features, fields) {
  const signals = fields.map(field => {
    if (field === "npxGDiff") {
      const home = features.home.rolling.npxG5;
      const away = features.away.rolling.npxG5;
      return Number.isFinite(home) && Number.isFinite(away) ? home - away : null;
    }
    return features.derived[field];
  }).filter(Number.isFinite);
  return average(signals);
}

function adjustWithXg(model, features, ablation) {
  if (!ablation.useXg) return model;
  const signal = xgSignal(features, ablation.fields || []);
  if (!Number.isFinite(signal)) return model;
  const effect = Math.max(-0.12, Math.min(0.12, signal * 0.08));
  const [home, draw, away] = softmax([
    logit(model.home) + effect,
    logit(model.draw) - Math.abs(effect) * 0.2,
    logit(model.away) - effect
  ]);
  return {
    ...model,
    home,
    draw,
    away,
    components: {
      ...model.components,
      xgEffect: effect,
      xgSignal: signal,
      xgFields: ablation.fields || []
    }
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
    drawCalibration: metrics.byResult.D,
    highProbabilityPerformance: metrics.highProbabilityPerformance
  };
}

export function xgIndependenceAudit(rows) {
  return {
    sampleSize: rows.length,
    correlations: {
      xGDiffVsPpgDiff: pearson(rows.map(row => [row.xg?.derived?.xGDiff, row.baseline?.model?.components?.ppgH - row.baseline?.model?.components?.ppgA])),
      xGDiffVsGoalDiff: pearson(rows.map(row => [row.xg?.derived?.xGDiff, row.baseline?.model?.components?.gdH - row.baseline?.model?.components?.gdA])),
      xGDiffVsForm: pearson(rows.map(row => [row.xg?.derived?.xGDiff, row.baseline?.model?.components?.formH - row.baseline?.model?.components?.formA])),
      xGDiffVsLambdaDiff: pearson(rows.map(row => [row.xg?.derived?.xGDiff, row.challenger?.model?.components?.lambdaHome - row.challenger?.model?.components?.lambdaAway])),
      xGDiffVsActualHomeWin: pearson(rows.map(row => [row.xg?.derived?.xGDiff, row.match.result === "H" ? 1 : 0]))
    }
  };
}

function seasonMaturity(predictions) {
  const groups = {
    early: predictions.filter(row => row.snapshotMeta?.teamHistoryMin >= 5 && row.snapshotMeta?.teamHistoryMin <= 9),
    mature: predictions.filter(row => row.snapshotMeta?.teamHistoryMin >= 10)
  };
  return Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, metricPack(rows)]));
}

export function runXgControlledExperiment(matches, xgCache, options = {}) {
  const dataset = buildPredictionDataset(matches, options);
  const baseVariant = CHALLENGER_VARIANTS.POISSON_ELO_FORM;
  const rows = dataset.rows.map(row => {
    const challenger = buildChallengerModel(row.fixture, row.context, baseVariant);
    const xg = xgCache.featuresForFixture(row.fixture);
    return { ...row, challenger, xg };
  }).filter(row => row.xg.status === "OK");

  if (rows.length < (options.minimumXgSample || 30)) {
    return {
      status: "INSUFFICIENT_DATA",
      reason: "Real historical xG sample is too small for controlled validation.",
      sampleSize: rows.length,
      requiredSample: options.minimumXgSample || 30,
      independenceAudit: xgIndependenceAudit(rows)
    };
  }

  const reports = Object.values(XG_ABLATIONS).map(ablation => {
    const predictions = rows.map(row => {
      const model = adjustWithXg(row.challenger.model, row.xg, ablation);
      return {
        fixtureId: row.match.fixtureId,
        competition: row.match.competition,
        competitionCode: row.match.competitionCode,
        season: row.match.season,
        utcDate: row.match.utcDate,
        actualResult: row.match.result,
        modelLabel: ablation.key,
        model,
        snapshotMeta: {
          ...row.context.meta,
          teamHistoryMin: Math.min(
            row.context.matches.filter(item => item.homeTeam?.id === row.fixture.homeId || item.awayTeam?.id === row.fixture.homeId).length,
            row.context.matches.filter(item => item.homeTeam?.id === row.fixture.awayId || item.awayTeam?.id === row.fixture.awayId).length
          )
        }
      };
    });
    const split = chronologicalSplit(predictions, options.developmentRatio ?? 0.7);
    return {
      label: ablation.key,
      development: metricPack(split.development),
      validation: metricPack(split.validation),
      seasonMaturity: seasonMaturity(split.validation),
      leaguePerformance: Object.fromEntries([...new Set(split.validation.map(row => row.competitionCode))]
        .map(code => [code, metricPack(split.validation.filter(row => row.competitionCode === code))]))
    };
  });

  return {
    status: "OK",
    sampleSize: rows.length,
    independenceAudit: xgIndependenceAudit(rows),
    ablations: reports,
    promotionRule: "Recommend integration only with validation log loss and Brier improvement, no material ECE deterioration, no league-only gain, no extreme-probability regression, and sufficient sample."
  };
}
