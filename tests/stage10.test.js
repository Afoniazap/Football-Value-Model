import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditCompetitionCoverage,
  competitionMarketSupport,
  marketSupportClass,
  ODDS_API_IO_LEAGUE_SLUGS,
  THE_ODDS_API_SPORT_KEYS
} from "../src/config/competitions.js";
import { blockerReasons } from "../src/diagnostics/blockers.js";
import { projectRequestBudget } from "../src/diagnostics/requestBudget.js";
import { createApiFootballIntelCache, fetchApiFootballFixtureIntel } from "../src/providers/apiFootball.js";
import { aggregateMarket } from "../src/providers/market/aggregateMarket.js";
import { createMarketCache } from "../src/providers/market/marketCache.js";
import { UI_LABELS } from "../src/ui/labels.js";
import { formatKyivDateLabel } from "../src/ui/time.js";
import { providerHealthLabel } from "../src/ui/telegram.js";

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fvm-stage10-"));
}

function fixture(id = "f1", code = "PL") {
  return {
    id,
    competitionCode: code,
    competition: code,
    utcDate: "2026-08-20T14:00:00Z",
    home: "Arsenal FC",
    away: "Chelsea FC",
    homeId: 57,
    awayId: 61
  };
}

function config(tmp) {
  return {
    root: tmp,
    oddsApiKey: "primary",
    oddsRegion: "eu",
    oddsApiIoKey: "odds-io",
    oddsApiIoBookmakers: "Book",
    oddsApiIoCacheMinutes: 10,
    oddsApiIoKickoffToleranceMinutes: 180,
    apiFootballKey: "api-football",
    apiFootballOddsCacheMinutes: 180,
    oddsFreshMinutes: 15,
    oddsStaleMinutes: 60,
    oddsRevisionThreshold: 0.02,
    marketMatchMinConfidence: 0.7,
    minDataQuality: 65,
    refreshMinutes: 30
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

async function testCentralCompetitionMapping() {
  assert.equal(THE_ODDS_API_SPORT_KEYS.PL, "soccer_epl");
  assert.equal(THE_ODDS_API_SPORT_KEYS.CLI, "soccer_conmebol_copa_libertadores");
  assert.equal(ODDS_API_IO_LEAGUE_SLUGS.PL, "england-premier-league");
  assert.equal(ODDS_API_IO_LEAGUE_SLUGS.PD, "spain-laliga");
  assert.equal(marketSupportClass("PL"), "SUPPORTED_BOTH");
  assert.equal(marketSupportClass("CLI"), "SUPPORTED_BOTH");
  assert.equal(competitionMarketSupport("CLI").primary, true);
  const audit = auditCompetitionCoverage([fixture("a", "PL"), fixture("b", "CLI"), fixture("c", "CLI")]);
  assert.equal(audit.supported, 3);
  assert.equal(audit.unsupported, 0);
  assert.deepEqual(audit.unsupportedTop.map(row => row.code), []);
}

async function testUnsupportedCompetitionPreciseWaitReason() {
  const tmp = root();
  const result = await aggregateMarket({
    request: async () => { throw new Error("should not call unsupported remote"); },
    config: config(tmp),
    sportKey: undefined,
    fixtures: [fixture("unknown-1", "UNKNOWN")],
    marketCache: createMarketCache(tmp),
    now: new Date("2026-08-20T10:00:00Z")
  });
  assert.equal(result.diagnostics["unknown-1"].reason, "MARKET_UNSUPPORTED_COMPETITION");
  const reasons = blockerReasons({
    id: "unknown-1",
    category: "wait",
    odds: null,
    dataQuality: 80,
    confidence: 80,
    diagnostics: {
      market: result.diagnostics["unknown-1"],
      dataQualityV2: { scoreNormalized: 80 },
      risk: { score: 90, redFlags: [] },
      sanityWarnings: []
    }
  }, { minDataQuality: 65, minEdgePercent: 4 });
  assert.ok(reasons.includes("MARKET_UNSUPPORTED_COMPETITION"));
}

async function testApiFootballRequestDedupAndMappingCache() {
  const tmp = root();
  const cache = createApiFootballIntelCache(tmp, { now: new Date("2026-08-20T12:45:00Z"), ttlMinutes: 30 });
  const calls = [];
  const request = async url => {
    const value = String(url);
    calls.push(value);
    if (value.includes("fixtures?")) return apiFixturePayload();
    if (value.includes("injuries")) return { response: [] };
    if (value.includes("fixtures/lineups")) return { response: [] };
    return { response: [] };
  };
  const first = await fetchApiFootballFixtureIntel({ request, apiFootballKey: "key", fixture: fixture("f1"), intelCache: cache });
  const second = await fetchApiFootballFixtureIntel({ request, apiFootballKey: "key", fixture: fixture("f1"), intelCache: cache });
  assert.equal(first.status, "OK");
  assert.equal(second.status, "OK");
  assert.equal(calls.filter(value => value.includes("fixtures?")).length, 1);
  assert.equal(calls.filter(value => value.includes("injuries")).length, 1);
  assert.equal(calls.filter(value => value.includes("fixtures/lineups")).length, 1);
  assert.ok(second.meta.mappingHits >= 1);

  const restarted = createApiFootballIntelCache(tmp, { now: new Date("2026-08-20T12:50:00Z"), ttlMinutes: 30 });
  await fetchApiFootballFixtureIntel({ request, apiFootballKey: "key", fixture: fixture("f1"), intelCache: restarted });
  assert.equal(calls.filter(value => value.includes("fixtures?")).length, 1);
}

async function testZeroInjuriesAndLineupsNotPublishedAreNotErrors() {
  const tmp = root();
  const cache = createApiFootballIntelCache(tmp, { now: new Date("2026-08-20T12:45:00Z"), ttlMinutes: 30 });
  const result = await fetchApiFootballFixtureIntel({
    request: async url => {
      const value = String(url);
      if (value.includes("fixtures?")) return apiFixturePayload();
      return { response: [] };
    },
    apiFootballKey: "key",
    fixture: fixture(),
    intelCache: cache
  });
  assert.equal(result.status, "OK");
  assert.equal(result.data.injuries.length, 0);
  assert.equal(result.data.lineups.length, 0);
  assert.equal(result.meta.endpoints.find(row => row.endpoint === "injuries").status, "OK");
  assert.equal(result.meta.endpoints.find(row => row.endpoint === "lineups").note, "NOT_PUBLISHED");
}

function testUtf8LabelsAndKyivFormatter() {
  assert.equal(providerHealthLabel({ status: "N/A", meta: { reason: "NO_ODDS" } }), "N/A (NO_ODDS)");
  assert.equal(providerHealthLabel(null), "N/A (NOT_REPORTED)");
  assert.equal(UI_LABELS.value, "VALUE");
  assert.equal(UI_LABELS.near, "NEAR");
  assert.equal(UI_LABELS.wait, "WAIT");
  assert.equal(UI_LABELS.noBet, "NO BET");
  assert.equal(UI_LABELS.risks, "Риски");
  assert.equal(UI_LABELS.metrics, "Метрики");
  assert.equal(UI_LABELS.sources, "Источники");
  assert.equal(UI_LABELS.whyNoValue, "Почему нет VALUE?");
  assert.equal(UI_LABELS.statistics, "Статистика");
  assert.equal(UI_LABELS.updated, "Обновлено");
  assert.equal(UI_LABELS.kyiv, "Киев");
  assert.ok(formatKyivDateLabel("2026-08-18T12:00:00Z").endsWith("Europe/Kyiv"));
}

function testRequestBudgetProjection() {
  const budget = projectRequestBudget({
    requestCounts: { httpHosts: { "api.football-data.org": 4, "v3.football.api-sports.io": 3, "api.odds-api.io": 1 } },
    refreshMinutes: 30,
    budgets: { footballData: 100, apiFootball: 100, oddsApiIo: 500, theOddsApi: 500 }
  });
  assert.equal(budget.refreshesPerDay, 48);
  assert.equal(budget.providers.footballData.projectedPerDay, 192);
  assert.equal(budget.providers.footballData.warning, "QUOTA_RISK");
  assert.equal(budget.providers.apiFootball.projectedPerDay, 144);
}

await testCentralCompetitionMapping();
await testUnsupportedCompetitionPreciseWaitReason();
await testApiFootballRequestDedupAndMappingCache();
await testZeroInjuriesAndLineupsNotPublishedAreNotErrors();
testUtf8LabelsAndKyivFormatter();
testRequestBudgetProjection();

console.log("Stage 10 tests OK: competition coverage, API-Football dedup, UTF-8 labels, Kyiv time and request budget.");
