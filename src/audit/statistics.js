import { calibrationReport } from "../backtest/calibration.js";
import { logLoss, multiclassBrier, predictedResult } from "../backtest/metrics.js";

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function kyivDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function emptyBetStats() {
  return {
    officialBets: 0,
    settledBets: 0,
    win: 0,
    loss: 0,
    push: 0,
    halfWin: 0,
    halfLoss: 0,
    void: 0,
    stakedUnits: 0,
    returns: 0,
    netUnits: 0,
    roi: null
  };
}

function addSettlement(stats, settlement) {
  stats.settledBets += 1;
  stats.stakedUnits += Number(settlement.stake || 0);
  stats.returns += Number(settlement.returns || 0);
  stats.netUnits += Number(settlement.netUnits || 0);
  if (settlement.status === "WIN") stats.win += 1;
  else if (settlement.status === "LOSS") stats.loss += 1;
  else if (settlement.status === "PUSH") stats.push += 1;
  else if (settlement.status === "HALF_WIN") stats.halfWin += 1;
  else if (settlement.status === "HALF_LOSS") stats.halfLoss += 1;
  else if (settlement.status === "VOID") stats.void += 1;
  stats.roi = stats.stakedUnits ? stats.netUnits / stats.stakedUnits : null;
}

function probabilityStats(rows, probabilityKey) {
  const predictions = rows
    .filter(row => row[probabilityKey] && row.actualResult)
    .map(row => ({ model: row[probabilityKey], actualResult: row.actualResult }));
  const correct = predictions.filter(row => predictedResult(row.model) === row.actualResult).length;
  return {
    sampleSize: predictions.length,
    brier: average(predictions.map(row => multiclassBrier(row.model, row.actualResult))),
    logLoss: average(predictions.map(row => logLoss(row.model, row.actualResult))),
    accuracy: predictions.length ? correct / predictions.length : null,
    ece: calibrationReport(predictions).expectedCalibrationError
  };
}

function oddsBand(odds) {
  const price = Number(odds);
  if (!Number.isFinite(price) || price <= 1) return "N/A";
  if (price < 1.8) return "1.50-1.79";
  if (price < 2) return "1.80-1.99";
  if (price < 2.5) return "2.00-2.49";
  return "2.50+";
}

function probabilityBand(probability) {
  const value = Number(probability);
  if (!Number.isFinite(value)) return "N/A";
  if (value < 0.4) return "<40";
  if (value < 0.5) return "40-49";
  if (value < 0.6) return "50-59";
  if (value < 0.7) return "60-69";
  return "70+";
}

function scoreBand(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "N/A";
  if (score < 50) return "<50";
  if (score < 65) return "50-64";
  if (score < 80) return "65-79";
  return "80+";
}

function groupedSettlements(signals, settlements, groupFn) {
  const signalById = new Map(signals.map(signal => [signal.signalId, signal]));
  const groups = {};
  for (const signal of signals) {
    const key = groupFn(signal, null);
    if (!groups[key]) groups[key] = emptyBetStats();
    groups[key].officialBets += 1;
  }
  for (const settlement of settlements) {
    const signal = signalById.get(settlement.signalId);
    const key = groupFn(signal, settlement);
    if (!groups[key]) groups[key] = emptyBetStats();
    addSettlement(groups[key], settlement);
  }
  return groups;
}

export function dailyAudit({ date, signals, settlements, shadowResults }) {
  const day = date || kyivDate(new Date());
  const daySignals = signals.filter(signal => kyivDate(signal.issuedAt || signal.analysedAt) === day);
  const daySettlements = settlements.filter(row => kyivDate(row.settledAt || row.finishedAt) === day);
  const stats = emptyBetStats();
  stats.officialBets = daySignals.length;
  for (const settlement of daySettlements) addSettlement(stats, settlement);
  const settledSignalIds = new Set(settlements.map(row => row.signalId));
  const pending = daySignals.filter(signal => !settledSignalIds.has(signal.signalId)).length;

  return {
    dateKyiv: day,
    officialValueIssued: daySignals.length,
    settled: daySettlements.length,
    pending: Math.max(0, pending),
    betting: stats,
    baselineProbability: probabilityStats(shadowResults, "baselineProbability"),
    challengerProbability: probabilityStats(shadowResults, "challengerProbability")
  };
}

export function cumulativeStatistics({ signals, settlements, shadowResults }) {
  const stats = emptyBetStats();
  stats.officialBets = signals.length;
  for (const settlement of settlements) addSettlement(stats, settlement);
  const signalIds = new Set(signals.map(signal => signal.signalId));
  const settledSignalIds = new Set(settlements.map(settlement => settlement.signalId));

  return {
    overall: stats,
    integrity: {
      officialSignals: signals.length,
      settlements: settlements.length,
      pending: signals.filter(signal => !settledSignalIds.has(signal.signalId)).length,
      settlementsWithoutSignal: settlements.filter(settlement => !signalIds.has(settlement.signalId)).length
    },
    byMarket: groupedSettlements(signals, settlements, signal => signal?.market || "unknown"),
    byCompetition: groupedSettlements(signals, settlements, signal => signal?.competition || "unknown"),
    bySource: groupedSettlements(signals, settlements, signal => signal?.marketSource || "N/A"),
    byOddsBand: groupedSettlements(signals, settlements, signal => oddsBand(signal?.officialOdds)),
    byModelProbabilityBand: groupedSettlements(signals, settlements, signal => probabilityBand(signal?.modelProbability)),
    byDqBand: groupedSettlements(signals, settlements, signal => scoreBand(signal?.DQ?.scoreNormalized ?? signal?.dataQuality)),
    byRiskBand: groupedSettlements(signals, settlements, signal => scoreBand(signal?.Risk?.score)),
    shadow: {
      sampleSize: shadowResults.length,
      baseline: probabilityStats(shadowResults, "baselineProbability"),
      challenger: probabilityStats(shadowResults, "challengerProbability")
    }
  };
}
