import { logLoss, multiclassBrier, predictedResult } from "./metrics.js";

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pearson(rows, xFn, yFn) {
  const pairs = rows
    .map(row => [xFn(row), yFn(row)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return null;

  const meanX = average(pairs.map(([x]) => x));
  const meanY = average(pairs.map(([, y]) => y));
  const numerator = pairs.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denomX = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0));
  const denomY = Math.sqrt(pairs.reduce((sum, [, y]) => sum + (y - meanY) ** 2, 0));
  return denomX && denomY ? numerator / (denomX * denomY) : null;
}

function groupPerformance(rows) {
  const groups = {
    matches5to9: rows.filter(item => item.snapshotMeta?.teamHistoryMin >= 5 && item.snapshotMeta?.teamHistoryMin <= 9),
    matches10to19: rows.filter(item => item.snapshotMeta?.teamHistoryMin >= 10 && item.snapshotMeta?.teamHistoryMin <= 19),
    matches20plus: rows.filter(item => item.snapshotMeta?.teamHistoryMin >= 20)
  };
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => {
    const correct = group.filter(item => predictedResult(item.model) === item.actualResult).length;
    return [key, {
      sampleSize: group.length,
      accuracy: group.length ? correct / group.length : null,
      brier: average(group.map(item => multiclassBrier(item.model, item.actualResult))),
      logLoss: average(group.map(item => logLoss(item.model, item.actualResult)))
    }];
  }));
}

export function featureAudit(predictions) {
  const usable = predictions.filter(item => item.model?.components);
  const notes = [];

  const componentRanges = {};
  for (const key of ["ppgH", "ppgA", "gdH", "gdA", "formH", "formA"]) {
    const values = usable.map(item => item.model.components[key]).filter(Number.isFinite);
    componentRanges[key] = values.length
      ? { min: Math.min(...values), max: Math.max(...values) }
      : { min: null, max: null };
  }

  notes.push("PPG, goal difference and recent form are correlated team-strength signals; possible double counting should be reviewed before Stage 4.");
  notes.push("Early-season matches are rejected when pre-match context lacks enough history.");
  notes.push("Draw probability is derived from absolute strength difference; calibration report should be used to detect draw under/overestimation.");
  notes.push("No market odds are used as model features in this diagnostic stage.");

  return {
    sampleSize: usable.length,
    componentRanges,
    correlations: {
      ppgDiffVsHomeProbability: pearson(usable, item => item.model.components.ppgH - item.model.components.ppgA, item => item.model.home),
      goalDiffVsHomeProbability: pearson(usable, item => item.model.components.gdH - item.model.components.gdA, item => item.model.home),
      formDiffVsHomeProbability: pearson(usable, item => item.model.components.formH - item.model.components.formA, item => item.model.home),
      ppgDiffVsActualHomeWin: pearson(usable, item => item.model.components.ppgH - item.model.components.ppgA, item => item.actualResult === "H" ? 1 : 0),
      goalDiffVsActualHomeWin: pearson(usable, item => item.model.components.gdH - item.model.components.gdA, item => item.actualResult === "H" ? 1 : 0),
      formDiffVsActualHomeWin: pearson(usable, item => item.model.components.formH - item.model.components.formA, item => item.actualResult === "H" ? 1 : 0)
    },
    seasonMaturity: groupPerformance(usable),
    notes
  };
}
