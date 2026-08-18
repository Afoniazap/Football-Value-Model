import { actualVector, logLoss, multiclassBrier, predictedResult } from "../backtest/metrics.js";
import { calibrationReport } from "../backtest/calibration.js";

export function scoreFinishedShadow(record, actualResult) {
  if (!record?.baselineProbability || !record?.challengerProbability || !actualResult) return null;
  return {
    fixtureId: record.fixtureId,
    actualResult,
    baselineBrier: multiclassBrier(record.baselineProbability, actualResult),
    challengerBrier: multiclassBrier(record.challengerProbability, actualResult),
    baselineLogLoss: logLoss(record.baselineProbability, actualResult),
    challengerLogLoss: logLoss(record.challengerProbability, actualResult),
    baselineTopPickCorrect: predictedResult(record.baselineProbability) === actualResult,
    challengerTopPickCorrect: predictedResult(record.challengerProbability) === actualResult,
    actualVector: actualVector(actualResult)
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function modelStats(rows, key) {
  const predictions = rows.map(row => ({
    model: row[key],
    actualResult: row.actualResult
  })).filter(row => row.model);
  const correct = predictions.filter(row => predictedResult(row.model) === row.actualResult).length;
  return {
    sampleSize: predictions.length,
    accuracy: predictions.length ? correct / predictions.length : null,
    brier: average(predictions.map(row => multiclassBrier(row.model, row.actualResult))),
    logLoss: average(predictions.map(row => logLoss(row.model, row.actualResult))),
    ece: calibrationReport(predictions).expectedCalibrationError
  };
}

export function shadowSummary(records) {
  const byFixture = new Map();
  for (const record of records.filter(item => item.actualResult)) {
    if (!byFixture.has(record.fixtureId)) byFixture.set(record.fixtureId, record);
  }
  const rows = [...byFixture.values()];
  const strong = rows.filter(row => row.disagreementStatus === "MODEL_STRONG_DISAGREEMENT");
  const agreement = rows.filter(row => row.topPickAgreement).length;

  return {
    sampleSize: rows.length,
    baseline: modelStats(rows, "baselineProbability"),
    challenger: modelStats(rows, "challengerProbability"),
    topPickAgreementRate: rows.length ? agreement / rows.length : null,
    strongDisagreementCount: strong.length,
    strongDisagreement: {
      baselineAccuracy: modelStats(strong, "baselineProbability").accuracy,
      challengerAccuracy: modelStats(strong, "challengerProbability").accuracy
    }
  };
}
