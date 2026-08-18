import { loadConfig } from "../src/config/env.js";
import { MODEL_VERSION, SPORT_KEYS } from "../src/config/constants.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchCompetitionContext, fetchFixtures } from "../src/providers/footballData.js";
import { fetchFinishedResults } from "../src/providers/results/footballDataResults.js";
import { fetchApiFootballFixtureIntel } from "../src/providers/apiFootball.js";
import { createLivePreMatchContext } from "../src/shadow/liveContext.js";
import { buildModel } from "../src/model/probability.js";
import { classify } from "../src/decision/classify.js";
import { calculateDataQuality } from "../src/quality/dataQuality.js";
import { calculateRisk, calculateDecisionConfidenceV2 } from "../src/risk/riskScore.js";
import { runSanityChecks } from "../src/model/sanityChecks.js";
import { buildShadowComparison } from "../src/shadow/comparison.js";
import { aggregateMarket } from "../src/providers/market/aggregateMarket.js";
import { createMarketCache } from "../src/providers/market/marketCache.js";
import { createCacheStore } from "../src/storage/cache.js";
import { createHistoryStore } from "../src/storage/history.js";
import { createSourceHealth } from "../src/diagnostics/sourceHealth.js";
import { auditExactHorizon } from "../src/diagnostics/horizon.js";
import { buildRefreshTelemetry, createRefreshTelemetry } from "../src/diagnostics/refreshTelemetry.js";
import { readinessLines, readinessState, startupReadiness } from "../src/diagnostics/readiness.js";

function createRequest(timeoutSeconds, counts) {
  const timeoutMs = timeoutSeconds * 1000;
  return async function request(url, options = {}) {
    const href = String(url);
    const host = new URL(href).host;
    counts[host] = (counts[host] || 0) + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text.slice(0, 220)}`);
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  };
}

function createInitialState() {
  return { updatedAt: null, loading: false, fixtures: [], value: [], near: [], wait: [], rejected: [], errors: [], sourceHealth: {} };
}

function createAnalysisId(date = new Date()) {
  return `${date.toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function applyMarketFreshnessGuard(classified, oddsEvent) {
  if (oddsEvent?.marketMeta?.freshness !== "STALE") return classified;
  return { ...classified, category: "wait", reason: "Market odds are STALE; official VALUE requires fresh market data." };
}

export async function runLiveRefresh({ commit = true } = {}) {
  const config = loadConfig();
  const requestCounts = {};
  const request = createRequest(config.requestTimeoutSeconds, requestCounts);
  const cacheStore = createCacheStore(config.root, createInitialState());
  const historyStore = createHistoryStore(config.root);
  const marketCache = createMarketCache(config.root);
  const refreshTelemetry = createRefreshTelemetry(config.root);
  const startedAt = new Date();
  const analysedAt = new Date();
  const analysisId = createAnalysisId(analysedAt);
  const providerResults = [];
  const timings = {};
  const marketAggregateMeta = { usageCounts: {}, oddsApiIoRequestsUsed: 0, secondaryRequestsUsed: 0 };

  console.log(readinessLines(startupReadiness(config)).join("\n"));

  let stageStarted = Date.now();
  const fixturesResult = await fetchFixtures({ request, token: config.footballDataToken, horizonHours: config.horizonHours });
  timings.fixtures = Date.now() - stageStarted;
  providerResults.push(fixturesResult);
  const fixturesFetched = (fixturesResult.data || []).length;
  const horizonAudit = auditExactHorizon(fixturesResult.data || [], { now: analysedAt, horizonHours: config.horizonHours });
  const fixtures = horizonAudit.accepted;
  const competitionCodes = [...new Set(fixtures.map(fixture => fixture.competitionCode).filter(Boolean))];

  const contexts = {};
  stageStarted = Date.now();
  for (const code of competitionCodes) {
    const contextResult = await fetchCompetitionContext({ request, token: config.footballDataToken, code });
    providerResults.push(contextResult);
    contexts[code] = contextResult.data;
  }
  timings.contexts = Date.now() - stageStarted;

  const marketByFixtureId = {};
  const marketDiagnosticsByFixtureId = {};
  stageStarted = Date.now();
  for (const code of competitionCodes) {
    const marketResult = await aggregateMarket({
      request,
      config,
      sportKey: SPORT_KEYS[code],
      fixtures: fixtures.filter(fixture => fixture.competitionCode === code),
      marketCache,
      now: analysedAt
    });
    providerResults.push(...marketResult.providerResults);
    Object.assign(marketByFixtureId, marketResult.byFixtureId);
    Object.assign(marketDiagnosticsByFixtureId, marketResult.diagnostics);
    for (const [source, count] of Object.entries(marketResult.meta?.usageCounts || {})) {
      marketAggregateMeta.usageCounts[source] = (marketAggregateMeta.usageCounts[source] || 0) + count;
    }
    marketAggregateMeta.oddsApiIoRequestsUsed += marketResult.meta?.oddsApiIoRequestsUsed || 0;
    marketAggregateMeta.secondaryRequestsUsed += marketResult.meta?.secondaryRequestsUsed || 0;
  }
  timings.markets = Date.now() - stageStarted;

  const apiFootballByFixture = {};
  stageStarted = Date.now();
  for (const fixture of fixtures) {
    const apiFootballResult = await fetchApiFootballFixtureIntel({ request, apiFootballKey: config.apiFootballKey, fixture });
    providerResults.push(apiFootballResult);
    apiFootballByFixture[fixture.id] = apiFootballResult;
  }
  timings.apiFootball = Date.now() - stageStarted;

  stageStarted = Date.now();
  const processed = fixtures.map(fixture => {
    const context = createLivePreMatchContext(contexts[fixture.competitionCode]);
    const modelled = buildModel(fixture, context);
    const oddsEvent = marketByFixtureId[fixture.id] || null;
    const classified = applyMarketFreshnessGuard(classify(modelled, oddsEvent, config), oddsEvent);
    const apiFootballResult = apiFootballByFixture[fixture.id];
    const fixtureProviders = providerResults.filter(result =>
      result.source === "football-data.fixtures" ||
      result.source === `football-data.context.${fixture.competitionCode}` ||
      result.source === `odds.${SPORT_KEYS[fixture.competitionCode]}` ||
      result.source === "odds-api-io" ||
      result.source === "odds.secondary" ||
      result.source === "market.cache" ||
      result.source === `api-football.${fixture.id}`
    );
    const dataQualityV2 = calculateDataQuality({ fixture, context, oddsEvent, apiFootballResult });
    const risk = calculateRisk({ item: classified, oddsEvent, apiFootballResult, providerStatuses: fixtureProviders });
    const providerHealth = createSourceHealth(fixtureProviders);
    const shadow = buildShadowComparison({ fixture, context, baseline: classified, oddsEvent, config, providerHealth });
    return {
      ...classified,
      shadow,
      diagnostics: {
        dataQualityV2,
        risk,
        decisionConfidenceV2: calculateDecisionConfidenceV2({ dataQuality: dataQualityV2, risk, modelAgreement: risk.modelAgreement, marketQuality: oddsEvent ? 100 : 0 }),
        sanityWarnings: runSanityChecks({ item: classified, dataQuality: dataQualityV2, minDataQuality: config.minDataQuality }),
        providerHealth,
        market: {
          ...marketDiagnosticsByFixtureId[fixture.id],
          source: oddsEvent?.marketMeta?.source || marketDiagnosticsByFixtureId[fixture.id]?.source || "NONE",
          freshness: oddsEvent?.marketMeta?.freshness || "N/A",
          observedAt: oddsEvent?.marketMeta?.observedAt || null,
          matchingConfidence: oddsEvent?.marketMeta?.matchingConfidence || marketDiagnosticsByFixtureId[fixture.id]?.confidence || null
        },
        apiFootball: {
          status: apiFootballResult.status,
          meta: apiFootballResult.meta,
          injuryCount: apiFootballResult.data?.injuries?.length || 0,
          lineupsCount: apiFootballResult.data?.lineups?.length || 0
        }
      }
    };
  });
  timings.model = Date.now() - stageStarted;

  const sourceHealth = createSourceHealth(providerResults);
  let officialNewSignals = 0;
  let signalRevisions = 0;
  let settlements = 0;

  if (commit) {
    stageStarted = Date.now();
    cacheStore.saveCache({
      updatedAt: analysedAt.toISOString(),
      fixtures: processed,
      value: processed.filter(item => item.category === "value"),
      near: processed.filter(item => item.category === "near"),
      wait: processed.filter(item => item.category === "wait"),
      rejected: processed.filter(item => item.category === "rejected"),
      errors: providerResults.filter(result => result.error).map(result => `${result.source}: ${result.error.code || "ERROR"}`),
      sourceHealth
    });
    const signalEventsBefore = historyStore.readSignalEvents().length;
    historyStore.appendAnalysis({
      analysisId,
      analysedAt: analysedAt.toISOString(),
      horizonStart: analysedAt.toISOString(),
      horizonEnd: new Date(analysedAt.getTime() + config.horizonHours * 3600_000).toISOString(),
      fixtures: processed.length,
      providerStatuses: sourceHealth,
      dataQuality: processed.map(item => ({ fixtureId: item.id, ...item.diagnostics.dataQualityV2 })),
      riskScore: processed.map(item => ({ fixtureId: item.id, score: item.diagnostics.risk.score, modelAgreement: item.diagnostics.risk.modelAgreement })),
      modelVersion: MODEL_VERSION
    });
    historyStore.appendSignals({ analysisId, analysedAt: analysedAt.toISOString(), items: processed, revisionThreshold: config.oddsRevisionThreshold });
    historyStore.appendShadowSignals({ analysisId, analysedAt: analysedAt.toISOString(), items: processed, revisionThreshold: config.oddsRevisionThreshold });
    officialNewSignals = historyStore.appendOfficialValueSignals({ analysisId, analysedAt: analysedAt.toISOString(), items: processed, modelVersion: MODEL_VERSION }).length;
    historyStore.lockSignalsAtKickoff({ now: analysedAt.toISOString() });
    const resultsResult = await fetchFinishedResults({
      request,
      token: config.footballDataToken,
      dateFrom: dateOnly(new Date(analysedAt.getTime() - 3 * 24 * 3600_000)),
      dateTo: dateOnly(analysedAt)
    });
    providerResults.push(resultsResult);
    for (const result of resultsResult.data || []) {
      const signal = historyStore.readOfficialSignals().find(row => row.fixtureId === result.fixtureId);
      if (signal && historyStore.settleOfficialSignal({ signalId: signal.signalId, result, settledAt: analysedAt.toISOString(), marketQuotes: marketCache.readQuotes(), closingWindowMinutes: config.closingWindowMinutes })) {
        settlements += 1;
      }
      historyStore.appendShadowResultAudit({ fixtureId: result.fixtureId, actualResult: result.result, finishedAt: result.finishedAt || analysedAt.toISOString() });
    }
    signalRevisions = Math.max(0, historyStore.readSignalEvents().length - signalEventsBefore - officialNewSignals);
    timings.storage = Date.now() - stageStarted;
  }

  const telemetry = buildRefreshTelemetry({
    refreshId: analysisId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config,
    fixturesFetched,
    horizonAudit,
    contexts,
    processed,
    providerResults,
    providerHealth: sourceHealth,
    marketAggregateMeta,
    officialNewSignals,
    signalRevisions,
    settlements,
    timings
  });
  telemetry.requestCounts.httpHosts = requestCounts;
  telemetry.systemReadiness = readinessState({ config, providerHealth: sourceHealth, marketCoverage: telemetry.coverage.market });
  if (commit) refreshTelemetry.appendRefresh(telemetry);
  return telemetry;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const telemetry = await runLiveRefresh({ commit: !process.argv.includes("--dry-run") });
  console.log(JSON.stringify({
    systemReadiness: telemetry.systemReadiness,
    fixturesFetched: telemetry.fixturesFetched,
    fixturesInsideExactHorizon: telemetry.fixturesInsideExactHorizon,
    market: telemetry.market,
    coverage: telemetry.coverage,
    dqDistribution: telemetry.dqDistribution,
    riskDistribution: telemetry.riskDistribution,
    categories: telemetry.categories,
    topBlockers: telemetry.blockers.top.slice(0, 10),
    providerHealth: telemetry.providerHealth,
    requestCounts: telemetry.requestCounts,
    durationMs: telemetry.durationMs,
    timings: telemetry.timings,
    errors: telemetry.errors
  }, null, 2));
}
