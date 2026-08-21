import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ODDS_API_IO_LEAGUE_SLUGS, THE_ODDS_API_SPORT_KEYS, marketSupportClass } from "../src/config/competitions.js";
import { createApiFootballIntelCache, fetchApiFootballFixtureIntel } from "../src/providers/apiFootball.js";
import { blockerReasons } from "../src/diagnostics/blockers.js";
import { refreshCoverage } from "../src/diagnostics/coverage.js";
import { createMarketCache } from "../src/providers/market/marketCache.js";
import { createXgCache } from "../src/providers/xg/xgCache.js";
import { runDoctor } from "../src/diagnostics/doctor.js";
import { createRefreshTelemetry } from "../src/diagnostics/refreshTelemetry.js";
import { createCacheStore } from "../src/storage/cache.js";
import { createHistoryStore } from "../src/storage/history.js";
import { createBacktestStore } from "../src/storage/backtestStore.js";
import { copyRuntimeData, resolveRuntimeRoot } from "../src/storage/runtime.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fvm-stage101-"));
}

function fixture(id = "f1", utcDate = "2026-08-20T14:00:00Z") {
  return {
    id,
    competitionCode: "PL",
    competition: "Premier League",
    utcDate,
    home: "Arsenal FC",
    away: "Chelsea FC",
    homeId: 57,
    awayId: 61
  };
}

function apiFixturePayload() {
  return {
    response: [{
      fixture: { id: 9001, date: "2026-08-20T14:00:00+00:00" },
      teams: { home: { name: "Arsenal FC" }, away: { name: "Chelsea FC" } }
    }]
  };
}

function lineupsPayload() {
  return { response: [{ team: { name: "Arsenal" }, startXI: [] }, { team: { name: "Chelsea" }, startXI: [] }] };
}

function apiRequest(calls, { injuries = { response: [] }, lineups = { response: [] } } = {}) {
  return async url => {
    const value = String(url);
    calls.push(value);
    if (value.includes("fixtures?")) return apiFixturePayload();
    if (value.includes("injuries")) return injuries;
    if (value.includes("fixtures/lineups")) return lineups;
    return { response: [] };
  };
}

async function testInjuriesTtlReuseAndZeroIsValid() {
  const root = tmpRoot();
  const calls = [];
  const firstCache = createApiFootballIntelCache(root, { now: new Date("2026-08-20T10:00:00Z"), injuriesCacheHours: 6 });
  const first = await fetchApiFootballFixtureIntel({ request: apiRequest(calls), apiFootballKey: "key", fixture: fixture(), intelCache: firstCache });
  assert.equal(first.data.injuries.length, 0);
  assert.equal(first.meta.endpoints.find(row => row.endpoint === "injuries").status, "OK");

  const secondCache = createApiFootballIntelCache(root, { now: new Date("2026-08-20T12:00:00Z"), injuriesCacheHours: 6 });
  await fetchApiFootballFixtureIntel({ request: apiRequest(calls), apiFootballKey: "key", fixture: fixture(), intelCache: secondCache });
  assert.equal(calls.filter(value => value.includes("injuries")).length, 1);
}

async function testLineupsSkippedBeforePrematchWindow() {
  const root = tmpRoot();
  const calls = [];
  const cache = createApiFootballIntelCache(root, { now: new Date("2026-08-20T10:00:00Z"), lineupsPrematchMinutes: 90 });
  const result = await fetchApiFootballFixtureIntel({ request: apiRequest(calls), apiFootballKey: "key", fixture: fixture(), intelCache: cache });
  assert.equal(calls.some(value => value.includes("fixtures/lineups")), false);
  const lineups = result.meta.endpoints.find(row => row.endpoint === "lineups");
  assert.equal(lineups.status, "N/A");
  assert.equal(lineups.reason, "EARLY_PREMATCH");
  assert.equal(cache.counters.lineupsSkippedEarly, 1);
}

async function testLineupsRequestedInsidePrematchWindow() {
  const root = tmpRoot();
  const calls = [];
  const cache = createApiFootballIntelCache(root, { now: new Date("2026-08-20T12:45:00Z"), lineupsPrematchMinutes: 90 });
  const result = await fetchApiFootballFixtureIntel({ request: apiRequest(calls), apiFootballKey: "key", fixture: fixture(), intelCache: cache });
  assert.equal(calls.filter(value => value.includes("fixtures/lineups")).length, 1);
  assert.equal(result.meta.endpoints.find(row => row.endpoint === "lineups").note, "NOT_PUBLISHED");
}

async function testConfirmedLineupCacheUntilKickoff() {
  const root = tmpRoot();
  const calls = [];
  const firstCache = createApiFootballIntelCache(root, { now: new Date("2026-08-20T12:45:00Z"), lineupsPrematchMinutes: 90, lineupsPrematchCacheMinutes: 15 });
  await fetchApiFootballFixtureIntel({ request: apiRequest(calls, { lineups: lineupsPayload() }), apiFootballKey: "key", fixture: fixture(), intelCache: firstCache });

  const secondCache = createApiFootballIntelCache(root, { now: new Date("2026-08-20T13:10:00Z"), lineupsPrematchMinutes: 90, lineupsPrematchCacheMinutes: 15 });
  const second = await fetchApiFootballFixtureIntel({ request: apiRequest(calls), apiFootballKey: "key", fixture: fixture(), intelCache: secondCache });
  assert.equal(calls.filter(value => value.includes("fixtures/lineups")).length, 1);
  assert.equal(second.meta.endpoints.find(row => row.endpoint === "lineups").source, "CONFIRMED_CACHE");
}

async function testQuotaDailyBackoffAndDedup() {
  const root = tmpRoot();
  let calls = 0;
  const request = async url => {
    const value = String(url);
    if (value.includes("fixtures?")) return apiFixturePayload();
    calls += 1;
    const error = new Error("429: You have reached the request limit for the day");
    throw error;
  };
  const cache = createApiFootballIntelCache(root, { now: new Date("2026-08-20T12:45:00Z") });
  const first = await fetchApiFootballFixtureIntel({ request, apiFootballKey: "key", fixture: fixture("f1"), intelCache: cache });
  const second = await fetchApiFootballFixtureIntel({ request, apiFootballKey: "key", fixture: fixture("f2"), intelCache: cache });
  assert.equal(first.status, "QUOTA");
  assert.equal(second.status, "QUOTA");
  assert.equal(calls, 1);
  assert.ok(cache.counters.quotaBackoffHits >= 1);
}

function testFallbackMarketDiagnosticsDoNotReportPrimaryQuotaBlocker() {
  const item = {
    id: "cli-1",
    category: "wait",
    odds: null,
    candidate: null,
    confidence: 55,
    dataQuality: 54,
    diagnostics: {
      market: {
        source: "ODDS_API_IO",
        observedAt: "2026-08-20T12:00:00Z",
        primaryStatus: "QUOTA",
        freshness: "FRESH"
      },
      dataQualityV2: { scoreNormalized: 54 },
      risk: { score: 88, redFlags: [] },
      sanityWarnings: []
    }
  };
  const reasons = blockerReasons(item, { minDataQuality: 65, minEdgePercent: 4 });
  assert.equal(reasons.includes("MARKET_PROVIDER_QUOTA"), false);
  const coverage = refreshCoverage({ fixtures: [fixture("cli-1")], processed: [item], providerHealth: {} });
  assert.equal(coverage.market.numerator, 1);
}
function testRuntimeRootResolutionAndPaths() {
  const project = tmpRoot();
  const runtime = path.join(project, "runtime-home");
  assert.equal(resolveRuntimeRoot(project, ""), path.join(project, "data"));
  assert.equal(resolveRuntimeRoot(project, "$HOME/.fvm-runtime", { HOME: runtime }), path.join(runtime, ".fvm-runtime"));

  const cache = createCacheStore(project, {}, { runtimeRoot: runtime });
  const history = createHistoryStore(project, { runtimeRoot: runtime });
  const market = createMarketCache(project, { runtimeRoot: runtime });
  const xg = createXgCache(project, { runtimeRoot: runtime });
  const telemetry = createRefreshTelemetry(project, { runtimeRoot: runtime });
  const backtest = createBacktestStore(project, { runtimeRoot: runtime });
  const doctor = runDoctor(project, { runtimeRoot: runtime });

  for (const file of [cache.cacheFile, history.analysesFile, market.quotesFile, xg.matchXgFile, telemetry.refreshHistoryFile, backtest.rawCachePath("x"), doctor.checkedFiles.marketQuotes]) {
    assert.ok(file.startsWith(runtime));
  }
}

function testMigrationIdempotency() {
  const project = tmpRoot();
  const runtime = path.join(project, "runtime");
  const sourceFile = path.join(project, "data", "history", "analyses.jsonl");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, '{"a":1}\n', "utf8");
  const first = copyRuntimeData({ fromRoot: project, toRuntimeRoot: runtime });
  const second = copyRuntimeData({ fromRoot: project, toRuntimeRoot: runtime });
  assert.deepEqual(first.copied, [path.join("history", "analyses.jsonl")]);
  assert.deepEqual(second.skipped, [path.join("history", "analyses.jsonl")]);
}

function testCliMappingRequiresProviderEvidence() {
  assert.equal(THE_ODDS_API_SPORT_KEYS.CLI, "soccer_conmebol_copa_libertadores");
  assert.equal(ODDS_API_IO_LEAGUE_SLUGS.CLI, "international-clubs-conmebol-libertadores-knockout-stage");
  assert.equal(marketSupportClass("CLI"), "SUPPORTED_BOTH");
}

await testInjuriesTtlReuseAndZeroIsValid();
await testLineupsSkippedBeforePrematchWindow();
await testLineupsRequestedInsidePrematchWindow();
await testConfirmedLineupCacheUntilKickoff();
await testQuotaDailyBackoffAndDedup();
testFallbackMarketDiagnosticsDoNotReportPrimaryQuotaBlocker();
testRuntimeRootResolutionAndPaths();
testMigrationIdempotency();
testCliMappingRequiresProviderEvidence();

console.log("Stage 10.1 tests OK: API-Football quota economy, runtime root, migration and CLI mapping guard.");