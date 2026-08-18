import { loadHistoricalMatches } from "../src/backtest/footballDataHistorical.js";
import { runBaselineBacktest } from "../src/backtest/baselineBacktest.js";
import { createBacktestStore } from "../src/storage/backtestStore.js";

function round(value, digits = 4) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : value;
}

function roundedObject(object) {
  return JSON.parse(JSON.stringify(object, (_key, value) => round(value)));
}

function conciseCalibration(calibration) {
  const nonEmpty = calibration.allOutcomes.filter(bin => bin.sampleSize > 0);
  return {
    expectedCalibrationError: calibration.expectedCalibrationError,
    populatedBins: nonEmpty.map(bin => ({
      bin: bin.bin,
      sampleSize: bin.sampleSize,
      meanPredicted: bin.meanPredicted,
      actualFrequency: bin.actualFrequency,
      calibrationError: bin.calibrationError
    }))
  };
}

function textReport({ loaded, report }) {
  const m = report.metrics;
  const calibration = conciseCalibration(report.calibration);
  return [
    "1. competitions: " + report.coverage.competitionCodes.join(", "),
    "2. seasons: " + report.coverage.seasons.join(", "),
    "3. matches downloaded: " + loaded.matches.length,
    "4. usable matches: " + report.coverage.matchesUsable,
    "5. rejected matches: " + report.coverage.matchesRejected + " " + JSON.stringify(report.coverage.rejectedReasons),
    "6. accuracy: " + round(m.accuracy),
    "7. Brier: " + round(m.brier),
    "8. log loss: " + round(m.logLoss),
    "9. ECE: " + round(report.calibration.expectedCalibrationError),
    "10. actual H/D/A distribution: " + JSON.stringify(m.actualDistribution),
    "11. predicted H/D/A distribution: " + JSON.stringify(m.predictedDistribution),
    "12. calibration summary: " + JSON.stringify(roundedObject(calibration)),
    "13. >=80 / >=90 probability performance: " + JSON.stringify(roundedObject({
      over80: m.highProbabilityPerformance.over80,
      over90: m.highProbabilityPerformance.over90
    })),
    "14. top causes of extreme wrong predictions: " + JSON.stringify(report.extremeCases.topWrongCauseCounts),
    "15. feature correlations: " + JSON.stringify(roundedObject(report.featureAudit.correlations)),
    "16. early vs mature season performance: " + JSON.stringify(roundedObject(report.featureAudit.seasonMaturity)),
    "17. limitations: football-data historical baseline only; no odds/market validation; no injuries/lineups; generated reports are local and intentionally untracked."
  ].join("\n");
}

const store = createBacktestStore(process.cwd());
const loaded = await loadHistoricalMatches({ store });
const report = runBaselineBacktest(loaded.matches, { minimumPriorMatches: 5 });

const summary = {
  generatedAt: new Date().toISOString(),
  sourceErrors: loaded.errors,
  coverage: report.coverage,
  metrics: report.metrics,
  calibrationSummary: conciseCalibration(report.calibration),
  highProbabilityPerformance: {
    over80: report.metrics.highProbabilityPerformance.over80,
    over90: report.metrics.highProbabilityPerformance.over90
  },
  extremeWrong: report.extremeCases.topWrong,
  extremeWrongCauseCounts: report.extremeCases.topWrongCauseCounts,
  featureAudit: report.featureAudit
};

store.saveBacktestReport("baseline-real-summary", roundedObject(summary));
store.saveBacktestReport("baseline-calibration", roundedObject(report.calibration));
store.saveBacktestReport("baseline-extremes", roundedObject(report.extremeCases));
store.saveBacktestReport("baseline-feature-audit", roundedObject(report.featureAudit));

const output = textReport({ loaded, report });
store.saveTextReport("baseline-report", output);
console.log(output);
