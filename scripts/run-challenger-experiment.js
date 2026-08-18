import { loadHistoricalMatches } from "../src/backtest/footballDataHistorical.js";
import { runChallengerExperiment } from "../src/backtest/challengerBacktest.js";
import { createBacktestStore } from "../src/storage/backtestStore.js";

function round(value, digits = 4) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : value;
}

function rounded(object) {
  return JSON.parse(JSON.stringify(object, (_key, value) => round(value)));
}

function metricRow(label, metrics) {
  return {
    model: label,
    sample: metrics.sample,
    accuracy: metrics.accuracy,
    brier: metrics.brier,
    logLoss: metrics.logLoss,
    ece: metrics.ece,
    drawTopPicks: metrics.draw.drawTopPicks,
    drawActualRate: metrics.draw.actualDrawRate,
    meanPredictedDraw: metrics.draw.meanPredictedDraw,
    over80HitRate: metrics.highProbabilityPerformance.over80.hitRate,
    over90HitRate: metrics.highProbabilityPerformance.over90.hitRate
  };
}

function makeTable(experiment) {
  const rows = [
    metricRow("BASELINE", experiment.baseline.validation),
    ...experiment.variants.map(variant => metricRow(variant.label, variant.validation)),
    metricRow("BEST CALIBRATED", experiment.bestCalibrated.validation)
  ];
  return rounded(rows);
}

function recommendation(experiment) {
  const baseline = experiment.baseline.validation;
  const calibrated = experiment.bestCalibrated.validation;
  const improvesLogLoss = calibrated.logLoss < baseline.logLoss;
  const improvesBrier = calibrated.brier < baseline.brier;
  const improvesEce = calibrated.ece < baseline.ece;
  const credibleDraw = calibrated.draw.meanPredictedDraw > 0.18 && calibrated.draw.meanPredictedDraw < 0.34;

  if (improvesLogLoss && improvesBrier && improvesEce && credibleDraw) {
    return "Proceed to Stage 5 live shadow testing, but keep baseline as production until shadow results include market-facing VALUE diagnostics.";
  }
  return "Do not proceed to Stage 5 yet; keep iterating challenger probability quality on development data.";
}

function outputText(experiment) {
  const bestRaw = experiment.bestRaw;
  const bestCalibrated = experiment.bestCalibrated;
  const baselineExtremeWrong = experiment.baseline.validationExtreme.topWrong.slice(0, 20);
  const calibratedExtremeWrong = bestCalibrated.validationExtreme.topWrong.slice(0, 20);
  return [
    "1. experiment table",
    JSON.stringify(makeTable(experiment), null, 2),
    "",
    "2. best raw model",
    JSON.stringify(rounded({
      label: bestRaw.label,
      development: metricRow(bestRaw.label, bestRaw.development),
      validation: metricRow(bestRaw.label, bestRaw.validation)
    }), null, 2),
    "",
    "3. best calibrated model",
    JSON.stringify(rounded({
      label: bestCalibrated.label,
      temperature: bestCalibrated.temperature,
      validation: metricRow(bestCalibrated.label, bestCalibrated.validation)
    }), null, 2),
    "",
    "4. draw behaviour",
    JSON.stringify(rounded({
      baseline: experiment.baseline.validation.draw,
      bestRaw: bestRaw.validation.draw,
      bestCalibrated: bestCalibrated.validation.draw
    }), null, 2),
    "",
    "5. extreme probability behaviour",
    JSON.stringify(rounded({
      baseline: {
        distribution: experiment.baseline.validation.probabilityDistribution,
        over80: experiment.baseline.validation.highProbabilityPerformance.over80,
        over90: experiment.baseline.validation.highProbabilityPerformance.over90
      },
      bestCalibrated: {
        distribution: bestCalibrated.validation.probabilityDistribution,
        over80: bestCalibrated.validation.highProbabilityPerformance.over80,
        over90: bestCalibrated.validation.highProbabilityPerformance.over90
      },
      top20ExtremeWrongBefore: baselineExtremeWrong,
      top20ExtremeWrongAfter: calibratedExtremeWrong
    }), null, 2),
    "",
    "6. early/mature season results",
    JSON.stringify(rounded(bestRaw.featureDiagnostics.seasonMaturity), null, 2),
    "",
    "7. evidence whether double counting improved",
    JSON.stringify(rounded({
      baselinePpgHomeProbabilityCorrelation: 0.9636,
      baselineGoalDiffHomeProbabilityCorrelation: 0.9234,
      baselineFormHomeProbabilityCorrelation: 0.8407,
      challengerLambdaDiffHomeProbabilityCorrelation: bestRaw.featureDiagnostics.lambdaDiffVsHomeProbability,
      challengerAttackDiffHomeProbabilityCorrelation: bestRaw.featureDiagnostics.attackDefenseDiffVsHomeProbability,
      note: "Challenger replaces separate PPG/GD/form softmax stacking with one Poisson goal process; form, when enabled, is capped."
    }), null, 2),
    "",
    "8. recommendation whether challenger is good enough to proceed to Stage 5 live shadow testing",
    recommendation(experiment)
  ].join("\n");
}

const store = createBacktestStore(process.cwd());
const loaded = await loadHistoricalMatches({ store });
const experiment = runChallengerExperiment(loaded.matches, { minimumPriorMatches: 5, developmentRatio: 0.7 });

store.saveBacktestReport("challenger-stage4-experiment", rounded(experiment));
const text = outputText(experiment);
store.saveTextReport("challenger-stage4-report", text);
console.log(text);
