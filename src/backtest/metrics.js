const EPSILON = 1e-15;

export function actualVector(result) {
  return {
    home: result === "H" ? 1 : 0,
    draw: result === "D" ? 1 : 0,
    away: result === "A" ? 1 : 0
  };
}

export function predictedResult(model) {
  const entries = [
    ["H", model.home],
    ["D", model.draw],
    ["A", model.away]
  ];
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

export function topProbability(model) {
  return Math.max(model.home, model.draw, model.away);
}

export function multiclassBrier(model, result) {
  const actual = actualVector(result);
  return (
    (model.home - actual.home) ** 2 +
    (model.draw - actual.draw) ** 2 +
    (model.away - actual.away) ** 2
  ) / 3;
}

export function logLoss(model, result) {
  const probability = result === "H"
    ? model.home
    : result === "D"
      ? model.draw
      : model.away;
  return -Math.log(Math.max(EPSILON, Math.min(1 - EPSILON, probability)));
}

export function probabilityDistribution(predictions) {
  const thresholds = { over70: 0, over80: 0, over90: 0, over95: 0 };
  for (const prediction of predictions) {
    const maxProbability = topProbability(prediction.model);
    if (maxProbability > 0.7) thresholds.over70 += 1;
    if (maxProbability > 0.8) thresholds.over80 += 1;
    if (maxProbability > 0.9) thresholds.over90 += 1;
    if (maxProbability > 0.95) thresholds.over95 += 1;
  }
  return thresholds;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function resultDistribution(rows, field) {
  const distribution = { H: 0, D: 0, A: 0 };
  for (const row of rows) {
    const result = field === "predicted" ? predictedResult(row.model) : row.actualResult;
    distribution[result] += 1;
  }
  return distribution;
}

function highProbabilityPerformance(rows, threshold) {
  const selected = rows.filter(item => topProbability(item.model) >= threshold);
  const correct = selected.filter(item => predictedResult(item.model) === item.actualResult).length;
  return {
    threshold,
    sampleSize: selected.length,
    meanPredictedProbability: average(selected.map(item => topProbability(item.model))),
    hitRate: selected.length ? correct / selected.length : null,
    brier: average(selected.map(item => multiclassBrier(item.model, item.actualResult))),
    logLoss: average(selected.map(item => logLoss(item.model, item.actualResult)))
  };
}

export function summarizeBacktest(predictions) {
  const usable = predictions.filter(item => item.model);
  const correct = usable.filter(item => predictedResult(item.model) === item.actualResult).length;
  const byResult = {};

  for (const label of ["H", "D", "A"]) {
    const rows = usable.filter(item => item.actualResult === label);
    byResult[label] = {
      sampleSize: rows.length,
      accuracy: rows.length
        ? rows.filter(item => predictedResult(item.model) === item.actualResult).length / rows.length
        : null,
      brier: average(rows.map(item => multiclassBrier(item.model, item.actualResult))),
      logLoss: average(rows.map(item => logLoss(item.model, item.actualResult)))
    };
  }

  return {
    sampleSize: usable.length,
    accuracy: usable.length ? correct / usable.length : null,
    brier: average(usable.map(item => multiclassBrier(item.model, item.actualResult))),
    logLoss: average(usable.map(item => logLoss(item.model, item.actualResult))),
    distribution: probabilityDistribution(usable),
    actualDistribution: resultDistribution(usable, "actual"),
    predictedDistribution: resultDistribution(usable, "predicted"),
    highProbabilityPerformance: {
      over70: highProbabilityPerformance(usable, 0.7),
      over80: highProbabilityPerformance(usable, 0.8),
      over90: highProbabilityPerformance(usable, 0.9)
    },
    byResult
  };
}
