import fs from "node:fs";
import path from "node:path";
import { blockerSummary } from "./blockers.js";
import { dqDistribution, refreshCoverage, riskDistribution } from "./coverage.js";
import { providerErrors } from "./operationalErrors.js";
import { readinessState } from "./readiness.js";
import { projectRequestBudget } from "./requestBudget.js";
import { auditCompetitionCoverage } from "../config/competitions.js";
import { resolveRuntimeRoot } from "../storage/runtime.js";

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

export function createRefreshTelemetry(root, { runtimeRoot = resolveRuntimeRoot(root) } = {}) {
  const diagnosticsDir = path.join(runtimeRoot, "diagnostics");
  const refreshHistoryFile = path.join(diagnosticsDir, "refresh-history.jsonl");

  function appendRefresh(record) {
    appendJsonl(refreshHistoryFile, record);
    return record;
  }

  return { diagnosticsDir, refreshHistoryFile, appendRefresh };
}

export function buildRefreshTelemetry({
  refreshId,
  startedAt,
  finishedAt,
  config,
  fixturesFetched = 0,
  horizonAudit,
  contexts = {},
  processed = [],
  providerResults = [],
  providerHealth = {},
  marketAggregateMeta = {},
  officialNewSignals = 0,
  signalRevisions = 0,
  settlements = 0,
  requestCounts = {},
  timings = {}
}) {
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const coverage = refreshCoverage({ fixtures: horizonAudit?.accepted || [], processed, providerHealth });
  const blockers = blockerSummary(processed, config);
  const categories = {
    VALUE: processed.filter(item => item.category === "value").length,
    NEAR: processed.filter(item => item.category === "near").length,
    WAIT: processed.filter(item => item.category === "wait").length,
    NO_BET: processed.filter(item => item.category === "rejected").length
  };
  const marketUsage = marketAggregateMeta.usageCounts || {};
  const competitionCoverage = auditCompetitionCoverage(horizonAudit?.accepted || []);

  return {
    refreshId,
    startedAt,
    finishedAt,
    durationMs,
    fixturesFetched,
    fixturesInsideExactHorizon: horizonAudit?.accepted?.length || 0,
    horizon: {
      earliestFixture: horizonAudit?.earliestFixture || null,
      latestFixture: horizonAudit?.latestFixture || null,
      actualHorizonSpanHours: horizonAudit?.actualHorizonSpanHours || 0,
      violations: horizonAudit?.rejected || []
    },
    competitions: competitionCoverage.rows.map(row => row.code),
    competitionCoverage,
    contextsFetched: Object.values(contexts).filter(Boolean).length,
    contextsFailed: providerResults.filter(result => result?.source?.startsWith("football-data.context.") && result.error).length,
    baselineModelsCalculated: processed.filter(item => item.model).length,
    challengerModelsCalculated: processed.filter(item => item.shadow?.shadowStatus === "OK").length,
    challengerNA: processed.filter(item => item.shadow?.shadowStatus !== "OK").length,
    market: {
      primaryFixtures: marketUsage.PRIMARY || 0,
      secondaryFixtures: (marketUsage.ODDS_API_IO || 0) + (marketUsage.SECONDARY || 0),
      cacheFixtures: marketUsage.CACHE || 0,
      noMarketFixtures: marketUsage.NONE || 0,
      usageCounts: marketUsage
    },
    coverage,
    dqDistribution: dqDistribution(processed),
    riskDistribution: riskDistribution(processed),
    categories,
    blockers,
    officialNewSignals,
    signalRevisions,
    settlements,
    providerHealth,
    requestCounts: {
      oddsApiIo: marketAggregateMeta.oddsApiIoRequestsUsed || 0,
      apiFootballOdds: marketAggregateMeta.secondaryRequestsUsed || 0,
      marketTotal: (marketAggregateMeta.oddsApiIoRequestsUsed || 0) + (marketAggregateMeta.secondaryRequestsUsed || 0),
      ...requestCounts
    },
    requestBudget: projectRequestBudget({
      requestCounts: {
        ...requestCounts,
        oddsApiIo: marketAggregateMeta.oddsApiIoRequestsUsed || 0,
        apiFootball: providerResults.filter(result => result?.source?.startsWith("api-football.")).reduce((max, result) =>
          Math.max(max, result.meta?.requestsUsed || 0), 0)
      },
      refreshMinutes: config.refreshMinutes
    }),
    timings,
    errors: providerErrors(providerResults, refreshId),
    warnings: []
  };
}

export function summarizeLatestTelemetry(record, config) {
  if (!record) return { system: readinessState({ config }), lines: [] };
  const system = readinessState({
    config,
    providerHealth: record.providerHealth,
    marketCoverage: record.coverage?.market
  });
  return {
    system,
    lines: [
      `System: ${system.status}`,
      `Matches: ${record.fixturesInsideExactHorizon}`,
      `Markets: ${record.coverage.market.numerator}/${record.coverage.market.denominator} (${record.coverage.market.percent}%)`,
      `DQ avg: ${record.dqDistribution.average ?? "N/A"}`,
      `Risk avg: ${record.riskDistribution.average ?? "N/A"}`,
      `VALUE/NEAR/WAIT/NO_BET: ${record.categories.VALUE}/${record.categories.NEAR}/${record.categories.WAIT}/${record.categories.NO_BET}`,
      `Top blockers: ${record.blockers.top.slice(0, 3).map(row => `${row.reason} ${row.count}`).join(", ") || "none"}`,
      `Duration: ${record.durationMs}ms`
    ]
  };
}
