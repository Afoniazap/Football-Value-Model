import { SourceStatus } from "../providers/providerResult.js";

function pct(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;
}

export function ratio(numerator, denominator, status = null) {
  return {
    numerator,
    denominator,
    percent: pct(numerator, denominator),
    status: status || (denominator === 0 ? SourceStatus.NA : numerator ? SourceStatus.OK : SourceStatus.NA)
  };
}

export function refreshCoverage({ fixtures = [], processed = [], providerHealth = {} }) {
  const total = fixtures.length;
  const apiFootballMatched = processed.filter(item => item.diagnostics?.apiFootball?.meta?.apiFixtureId).length;
  const injuries = processed.filter(item => (item.diagnostics?.apiFootball?.injuryCount || 0) > 0).length;
  const lineups = processed.filter(item => (item.diagnostics?.apiFootball?.lineupsCount || 0) > 0).length;
  const xgStatus = providerHealth.xg?.status || SourceStatus.NA;
  const xgConfigured = xgStatus !== SourceStatus.NA;

  return {
    footballData: ratio(total, total, total ? SourceStatus.OK : SourceStatus.NA),
    market: ratio(processed.filter(item => Boolean(item.odds)).length, total),
    apiFootball: ratio(apiFootballMatched, total, providerHealth["api-football"]?.status || SourceStatus.NA),
    injuries: ratio(injuries, total, providerHealth["api-football"]?.status || SourceStatus.NA),
    lineups: ratio(lineups, total, providerHealth["api-football"]?.status || SourceStatus.NA),
    xg: ratio(0, total, xgConfigured ? xgStatus : SourceStatus.NA)
  };
}

export function scoreDistribution(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const average = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  const middle = Math.floor(sorted.length / 2);
  return {
    average: average === null ? null : Number(average.toFixed(1)),
    median: sorted.length
      ? sorted.length % 2 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(1))
      : null,
    high: sorted.filter(value => value >= 70).length,
    mid: sorted.filter(value => value >= 50 && value < 70).length,
    low: sorted.filter(value => value < 50).length
  };
}

export function dqDistribution(processed = []) {
  return scoreDistribution(processed.map(item => item.diagnostics?.dataQualityV2?.scoreNormalized));
}

export function riskDistribution(processed = []) {
  return scoreDistribution(processed.map(item => item.diagnostics?.risk?.score));
}
