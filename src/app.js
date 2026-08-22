import { loadConfig } from "./config/env.js";
import { MODEL_VERSION, SPORT_KEYS } from "./config/constants.js";
import { fetchCompetitionContext, fetchFixtures } from "./providers/footballData.js";
import { fetchFinishedResults } from "./providers/results/footballDataResults.js";
import { createApiFootballIntelCache, fetchApiFootballFixtureIntel } from "./providers/apiFootball.js";
import { buildModel } from "./model/probability.js";
import { classify } from "./decision/classify.js";
import { calculateDataQuality } from "./quality/dataQuality.js";
import { calculateRisk, calculateDecisionConfidenceV2 } from "./risk/riskScore.js";
import { runSanityChecks } from "./model/sanityChecks.js";
import { createCacheStore } from "./storage/cache.js";
import { createHistoryStore } from "./storage/history.js";
import { createSourceHealth } from "./diagnostics/sourceHealth.js";
import { createTelegramUi } from "./ui/telegram.js";
import { createLivePreMatchContext } from "./shadow/liveContext.js";
import { buildShadowComparison } from "./shadow/comparison.js";
import { aggregateMarket } from "./providers/market/aggregateMarket.js";
import { createMarketCache } from "./providers/market/marketCache.js";
import { auditExactHorizon } from "./diagnostics/horizon.js";
import { buildRefreshTelemetry, createRefreshTelemetry } from "./diagnostics/refreshTelemetry.js";
import { providerErrors } from "./diagnostics/operationalErrors.js";
import { readinessLines, readinessState, startupReadiness } from "./diagnostics/readiness.js";
import { createContextEngine } from "./context/contextEngine.js";

function createInitialState() {
  return {
    updatedAt: null,
    loading: false,
    fixtures: [],
    value: [],
    near: [],
    wait: [],
    rejected: [],
    errors: [],
    sourceHealth: {}
  };
}

function createRequest(timeoutSeconds) {
  const timeoutMs = timeoutSeconds * 1000;

  return async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text.slice(0, 220)}`);
      }
      return response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Request timeout after ${timeoutSeconds}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function createTelegramRequest(config, request) {
  const tgApi = `https://api.telegram.org/bot${config.telegramToken}`;

  return async function tg(method, body = {}) {
    const data = await request(`${tgApi}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  };
}

function providerErrorMessages(results) {
  return providerErrors(results)
    .map(error => `${error.source}: ${error.code}: ${error.message}`);
}

function createAnalysisId(date = new Date()) {
  return `${date.toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function applyMarketFreshnessGuard(classified, oddsEvent) {
  const freshness = oddsEvent?.marketMeta?.freshness;
  if (freshness !== "STALE") return classified;
  return {
    ...classified,
    category: "wait",
    reason: "Market odds are STALE; official VALUE requires fresh market data."
  };
}

export async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error("Ошибка конфигурации:", error.message);
    process.exit(1);
  }

  const request = createRequest(config.requestTimeoutSeconds);
  const tg = createTelegramRequest(config, request);
  const cacheStore = createCacheStore(config.root, createInitialState(), { runtimeRoot: config.runtimeRoot });
  const historyStore = createHistoryStore(config.root, { runtimeRoot: config.runtimeRoot });
  const marketCache = createMarketCache(config.root, { runtimeRoot: config.runtimeRoot });
  const refreshTelemetry = createRefreshTelemetry(config.root, { runtimeRoot: config.runtimeRoot });
  const contextEngine = createContextEngine({ config: config.context, runtimeRoot: config.runtimeRoot });
  const stateRef = { current: cacheStore.loadCache() };
  const bootReadiness = startupReadiness(config);

  async function refreshData() {
    if (stateRef.current.loading) return;
    stateRef.current.loading = true;
    stateRef.current.errors = [];

    const startedAt = new Date();
    const providerResults = [];
    const analysedAt = new Date();
    const horizonStart = analysedAt.toISOString();
    const horizonEnd = new Date(analysedAt.getTime() + config.horizonHours * 3600_000).toISOString();
    const analysisId = createAnalysisId(analysedAt);
    const timings = {};
    let fixturesFetched = 0;
    let horizonAudit = null;
    let contexts = {};
    let processed = [];
    let officialNewSignals = 0;
    let signalRevisions = 0;
    let settlements = 0;
    const marketAggregateMeta = {
      usageCounts: {},
      oddsApiIoRequestsUsed: 0,
      secondaryRequestsUsed: 0
    };

    try {
      let stageStarted = Date.now();
      const fixturesResult = await fetchFixtures({
        request,
        token: config.footballDataToken,
        horizonHours: config.horizonHours
      });
      timings.fixtures = Date.now() - stageStarted;
      providerResults.push(fixturesResult);

      fixturesFetched = (fixturesResult.data || []).length;
      horizonAudit = auditExactHorizon(fixturesResult.data || [], {
        now: analysedAt,
        horizonHours: config.horizonHours
      });
      for (const violation of horizonAudit.rejected) {
        providerResults.push({
          status: "ERROR",
          source: "horizon.audit",
          fetchedAt: analysedAt.toISOString(),
          data: null,
          error: { code: "HORIZON_VIOLATION", message: `Fixture ${violation.fixtureId || "unknown"} outside exact horizon` },
          meta: violation
        });
      }

      const fixtures = horizonAudit.accepted;
      const competitionCodes = [...new Set(fixtures.map(f => f.competitionCode).filter(Boolean))];

      stageStarted = Date.now();
      for (const code of competitionCodes) {
        const contextResult = await fetchCompetitionContext({
          request,
          token: config.footballDataToken,
          code
        });
        providerResults.push(contextResult);
        contexts[code] = contextResult.data;
      }
      timings.contexts = Date.now() - stageStarted;

      const marketByFixtureId = {};
      const marketDiagnosticsByFixtureId = {};
      stageStarted = Date.now();
      for (const code of competitionCodes) {
        const sportKey = SPORT_KEYS[code];
        const marketResult = await aggregateMarket({
          request,
          config,
          sportKey,
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
      const apiFootballIntelCache = createApiFootballIntelCache(config.root, {
        runtimeRoot: config.runtimeRoot,
        now: analysedAt,
        ttlMinutes: config.refreshMinutes,
        injuriesCacheHours: config.injuriesCacheHours,
        lineupsEarlyCacheHours: config.lineupsEarlyCacheHours,
        lineupsPrematchMinutes: config.lineupsPrematchMinutes,
        lineupsPrematchCacheMinutes: config.lineupsPrematchCacheMinutes
      });
      stageStarted = Date.now();
      for (const fixture of fixtures) {
        const apiFootballResult = await fetchApiFootballFixtureIntel({
          request,
          apiFootballKey: config.apiFootballKey,
          fixture,
          intelCache: apiFootballIntelCache
        });
        providerResults.push(apiFootballResult);
        apiFootballByFixture[fixture.id] = apiFootballResult;
      }
      timings.apiFootball = Date.now() - stageStarted;

      stageStarted = Date.now();
      const contextResult = await contextEngine.collectFixtures(fixtures);
      providerResults.push(...contextResult.providerResults);
      timings.context = Date.now() - stageStarted;

      stageStarted = Date.now();
      processed = fixtures.map(fixture => {
        const fixtureContext = createLivePreMatchContext(contexts[fixture.competitionCode]);
        const modelled = buildModel(fixture, fixtureContext);
        const oddsEvent = marketByFixtureId[fixture.id] || null;
        const classified = applyMarketFreshnessGuard(classify(modelled, oddsEvent, config), oddsEvent);
        const apiFootballResult = apiFootballByFixture[fixture.id];
        const fixtureProviders = providerResults.filter(result =>
          result.source === "football-data.fixtures" ||
          result.source === `football-data.context.${fixture.competitionCode}` ||
          result.source === `odds.${SPORT_KEYS[fixture.competitionCode]}` ||
          result.source === "odds.secondary" ||
          result.source === "market.cache" ||
          result.source === `api-football.${fixture.id}`
        );
        const dataQualityV2 = calculateDataQuality({
          fixture,
          context: fixtureContext,
          oddsEvent,
          apiFootballResult
        });
        const risk = calculateRisk({
          item: classified,
          oddsEvent,
          apiFootballResult,
          providerStatuses: fixtureProviders
        });
        const sanityWarnings = runSanityChecks({
          item: classified,
          dataQuality: dataQualityV2,
          minDataQuality: config.minDataQuality
        });
        const marketQuality = oddsEvent ? 100 : 0;
        const providerHealth = createSourceHealth(fixtureProviders);
        const shadow = buildShadowComparison({
          fixture,
          context: fixtureContext,
          baseline: classified,
          oddsEvent,
          config,
          providerHealth
        });

        return {
          ...classified,
          shadow,
          contextAnalysis: contextResult.byFixtureId[fixture.id],
          diagnostics: {
            dataQualityV2,
            risk,
            decisionConfidenceV2: calculateDecisionConfidenceV2({
              dataQuality: dataQualityV2,
              risk,
              modelAgreement: risk.modelAgreement,
              marketQuality
            }),
            sanityWarnings,
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

      stateRef.current = {
        ...stateRef.current,
        fixtures: processed,
        value: processed.filter(x => x.category === "value"),
        near: processed.filter(x => x.category === "near"),
        wait: processed.filter(x => x.category === "wait"),
        rejected: processed.filter(x => x.category === "rejected"),
        updatedAt: analysedAt.toISOString(),
        errors: providerErrorMessages(providerResults),
        sourceHealth: createSourceHealth(providerResults)
      };

      stageStarted = Date.now();
      cacheStore.saveCache(stateRef.current);
      historyStore.appendAnalysis({
        analysisId,
        analysedAt: analysedAt.toISOString(),
        horizonStart,
        horizonEnd,
        fixtures: processed.length,
        providerStatuses: stateRef.current.sourceHealth,
        dataQuality: processed.map(item => ({
          fixtureId: item.id,
          scoreNormalized: item.diagnostics?.dataQualityV2?.scoreNormalized,
          rawScore: item.diagnostics?.dataQualityV2?.rawScore,
          availableMax: item.diagnostics?.dataQualityV2?.availableMax,
          components: item.diagnostics?.dataQualityV2?.components
        })),
        riskScore: processed.map(item => ({
          fixtureId: item.id,
          score: item.diagnostics?.risk?.score,
          modelAgreement: item.diagnostics?.risk?.modelAgreement
        })),
        redFlags: processed.flatMap(item =>
          (item.diagnostics?.risk?.redFlags || []).map(flag => ({ fixtureId: item.id, ...flag }))
        ),
        sanityWarnings: processed.flatMap(item =>
          (item.diagnostics?.sanityWarnings || []).map(warning => ({ fixtureId: item.id, ...warning }))
        ),
        contextAnalysis: processed.map(item => ({ fixtureId: item.id, ...item.contextAnalysis })),
        modelVersion: MODEL_VERSION
      });
      const signalEventsBefore = historyStore.readSignalEvents().length;
      historyStore.appendSignals({
        analysisId,
        analysedAt: analysedAt.toISOString(),
        items: processed,
        revisionThreshold: config.oddsRevisionThreshold
      });
      historyStore.appendShadowSignals({
        analysisId,
        analysedAt: analysedAt.toISOString(),
        items: processed,
        revisionThreshold: config.oddsRevisionThreshold
      });
      const issuedSignals = historyStore.appendOfficialValueSignals({
        analysisId,
        analysedAt: analysedAt.toISOString(),
        items: processed,
        modelVersion: MODEL_VERSION
      });
      officialNewSignals = issuedSignals.length;
      historyStore.lockSignalsAtKickoff({ now: analysedAt.toISOString() });

      const resultsFrom = dateOnly(new Date(analysedAt.getTime() - 3 * 24 * 3600_000));
      const resultsTo = dateOnly(analysedAt);
      const resultsResult = await fetchFinishedResults({
        request,
        token: config.footballDataToken,
        dateFrom: resultsFrom,
        dateTo: resultsTo
      });
      providerResults.push(resultsResult);
      for (const result of resultsResult.data || []) {
        const signal = historyStore.readOfficialSignals().find(row => row.fixtureId === result.fixtureId);
        if (signal) {
          const settled = historyStore.settleOfficialSignal({
            signalId: signal.signalId,
            result,
            settledAt: analysedAt.toISOString(),
            marketQuotes: marketCache.readQuotes(),
            closingWindowMinutes: config.closingWindowMinutes
          });
          if (settled) settlements += 1;
        }
        historyStore.appendShadowResultAudit({
          fixtureId: result.fixtureId,
          actualResult: result.result,
          finishedAt: result.finishedAt || analysedAt.toISOString()
        });
      }
      signalRevisions = Math.max(0, historyStore.readSignalEvents().length - signalEventsBefore - officialNewSignals);
      timings.storage = Date.now() - stageStarted;

      const telemetryRecord = buildRefreshTelemetry({
        refreshId: analysisId,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        config,
        fixturesFetched,
        horizonAudit,
        contexts,
        processed,
        providerResults,
        providerHealth: stateRef.current.sourceHealth,
        marketAggregateMeta,
        officialNewSignals,
        signalRevisions,
        settlements,
        timings
      });
      stateRef.current.systemReadiness = readinessState({
        config,
        providerHealth: stateRef.current.sourceHealth,
        marketCoverage: telemetryRecord.coverage.market
      });
      stateRef.current.telemetry = telemetryRecord;
      refreshTelemetry.appendRefresh(telemetryRecord);
      cacheStore.saveCache(stateRef.current);

      console.log(
        `Обновлено ${processed.length} матчей | VALUE ${stateRef.current.value.length} | Near ${stateRef.current.near.length} | WAIT ${stateRef.current.wait.length} | NO BET ${stateRef.current.rejected.length}`
      );
    } catch (error) {
      stateRef.current.errors.push(error.message);
      console.error("Refresh error:", error.message);
      const finishedAt = new Date().toISOString();
      const sourceHealth = createSourceHealth(providerResults);
      stateRef.current.sourceHealth = sourceHealth;
      stateRef.current.systemReadiness = readinessState({ config, providerHealth: sourceHealth });
      stateRef.current.telemetry = buildRefreshTelemetry({
        refreshId: analysisId,
        startedAt: startedAt.toISOString(),
        finishedAt,
        config,
        fixturesFetched,
        horizonAudit: horizonAudit || { accepted: [], rejected: [] },
        contexts,
        processed,
        providerResults: [
          ...providerResults,
          {
            status: "ERROR",
            source: "refresh",
            fetchedAt: finishedAt,
            data: null,
            error: { code: "INTERNAL", message: error.message },
            meta: {}
          }
        ],
        providerHealth: sourceHealth,
        marketAggregateMeta,
        timings
      });
      refreshTelemetry.appendRefresh(stateRef.current.telemetry);
      cacheStore.saveCache(stateRef.current);
    } finally {
      stateRef.current.loading = false;
    }
  }

  const ui = createTelegramUi({
    config,
    tg,
    stateRef,
    refreshData,
    shadowStats: historyStore.shadowStats,
    auditStats: historyStore.auditCumulative,
    dailyAudit: historyStore.auditDaily
  });
  let offset = 0;

  console.log("FVM v1.0 CLEAN запускается...");
  console.log(`Рабочая папка: ${config.root}`);

  console.log(readinessLines(bootReadiness).join("\n"));
  await refreshData();
  setInterval(refreshData, config.refreshMinutes * 60_000);

  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await ui.handleMessage(update.message);
        if (update.callback_query) await ui.handleCallback(update.callback_query);
      }
    } catch (error) {
      console.error(new Date().toISOString(), error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

main();
