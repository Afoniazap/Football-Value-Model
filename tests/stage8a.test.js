import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateClv } from "../src/audit/clv.js";
import { aggregateMarket } from "../src/providers/market/aggregateMarket.js";
import { createMarketCache } from "../src/providers/market/marketCache.js";
import { matchOddsApiIoEvent, oddsProviderOddsApiIo } from "../src/providers/market/oddsApiIo.js";
import { oddsProviderSecondary } from "../src/providers/market/secondaryOdds.js";

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fvm-stage8a-"));
}

function fixture(id = "fixture-1") {
  return {
    id,
    competitionCode: "PL",
    competition: "Premier League",
    utcDate: "2026-08-20T14:00:00Z",
    home: "Arsenal FC",
    away: "Chelsea FC",
    homeId: 57,
    awayId: 61
  };
}

function primaryEvent(home = 2.05, draw = 3.45, away = 3.6) {
  return {
    id: "primary-1",
    sport_key: "soccer_epl",
    commence_time: "2026-08-20T14:00:00Z",
    home_team: "Arsenal FC",
    away_team: "Chelsea FC",
    bookmakers: [{
      title: "PrimaryBook",
      markets: [{
        key: "h2h",
        outcomes: [
          { name: "Arsenal FC", price: home },
          { name: "Draw", price: draw },
          { name: "Chelsea FC", price: away }
        ]
      }]
    }]
  };
}

function apiFootballPayload(home = "Arsenal", away = "Chelsea") {
  return {
    response: [{
      fixture: { id: 9001, date: "2026-08-20T14:00:00+00:00" },
      league: { id: 39, name: "Premier League" },
      teams: { home: { name: home }, away: { name: away } },
      update: "2026-08-20T10:00:00+00:00",
      bookmakers: [{
        id: 1,
        name: "SecondaryBook",
        bets: [{
          id: 1,
          name: "Match Winner",
          values: [
            { value: "Home", odd: "2.10" },
            { value: "Draw", odd: "3.30" },
            { value: "Away", odd: "3.50" }
          ]
        }]
      }]
    }]
  };
}

function config(tmp, overrides = {}) {
  return {
    root: tmp,
    oddsApiKey: "primary-key",
    oddsRegion: "eu",
    oddsApiIoKey: "",
    oddsApiIoBookmakers: "",
    oddsApiIoCacheMinutes: 10,
    oddsApiIoKickoffToleranceMinutes: 180,
    apiFootballKey: "secondary-key",
    apiFootballOddsCacheMinutes: 180,
    oddsFreshMinutes: 15,
    oddsStaleMinutes: 60,
    oddsRevisionThreshold: 0.02,
    marketMatchMinConfidence: 0.7,
    ...overrides
  };
}

function oddsApiIoEvents(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `oddsio-${index + 1}`,
    date: "2026-08-20T14:00:00Z",
    home: count === 1 ? "Arsenal FC" : `Home ${index + 1} FC`,
    away: count === 1 ? "Chelsea FC" : `Away ${index + 1} FC`,
    league: { name: "Premier League", slug: "england-premier-league" }
  }));
}

function oddsApiIoOdds(ids = ["oddsio-1"]) {
  return ids.map((id, index) => ({
    id,
    date: "2026-08-20T14:00:00Z",
    home: ids.length === 1 ? "Arsenal FC" : `Home ${index + 1} FC`,
    away: ids.length === 1 ? "Chelsea FC" : `Away ${index + 1} FC`,
    league: { name: "Premier League", slug: "england-premier-league" },
    bookmakers: [{
      title: "OddsIoBook",
      markets: [
        { name: "ML", odds: [{ home: 2.12, draw: 3.25, away: 3.55 }] },
        { name: "ML HT", odds: [{ home: 3.1, draw: 2.2, away: 3.3 }] },
        { name: "Total", odds: [{ name: "Over 2.5", price: 1.91 }, { name: "Under 2.5", price: 1.89 }] },
        { name: "Spread", odds: [{ hdp: -0.5, home: "2.05", away: "1.80" }] },
        { name: "Totals", odds: [{ hdp: 2.5, over: "1.91", under: "1.89" }] }
      ]
    }]
  }));
}

function createRequest({
  primary = "quota",
  secondary = "ok",
  oddsApiIo = "na",
  secondaryPayload = apiFootballPayload(),
  oddsApiIoEventPayload = oddsApiIoEvents(),
  calls
}) {
  return async url => {
    const value = String(url);
    if (value.includes("the-odds-api")) {
      if (primary === "ok") return [primaryEvent()];
      if (primary === "error") throw new Error("500: primary error");
      throw new Error("OUT_OF_USAGE_CREDITS");
    }
    if (value.includes("odds-api.io")) {
      calls.oddsApiIo = (calls.oddsApiIo || 0) + 1;
      if (oddsApiIo === "quota") throw new Error("429: quota");
      if (oddsApiIo === "error") throw new Error("500: odds-api.io error");
      if (value.includes("/events")) return oddsApiIoEventPayload;
      if (value.includes("/odds/multi")) {
        const ids = new URL(value).searchParams.get("eventIds").split(",");
        return oddsApiIoOdds(ids);
      }
    }
    if (value.includes("api-sports")) {
      calls.secondary += 1;
      if (secondary === "error") throw new Error("429: quota");
      return secondaryPayload;
    }
    return [];
  };
}

async function testOddsApiIoNormalizationAndBatching() {
  const tmp = root();
  const calls = { secondary: 0, oddsApiIo: 0 };
  const fixtures = Array.from({ length: 11 }, (_, index) => ({
    ...fixture(`fixture-${index + 1}`),
    home: `Home ${index + 1} FC`,
    away: `Away ${index + 1} FC`
  }));
  const result = await oddsProviderOddsApiIo({
    request: createRequest({ oddsApiIo: "ok", oddsApiIoEventPayload: oddsApiIoEvents(11), calls }),
    oddsApiIoKey: "odds-api-io-key",
    oddsApiIoBookmakers: "OddsIoBook",
    fixtures,
    root: tmp,
    now: new Date("2026-08-20T10:00:00Z"),
    cacheMinutes: 10
  });
  assert.equal(result.status, "OK");
  assert.equal(result.meta.eventRequests, 1);
  assert.equal(result.meta.oddsBatchRequests, 2);
  assert.equal(result.meta.requestsUsed, 3);
  assert.equal(result.events.length, 11);
  assert.equal(result.events[0].source, "ODDS_API_IO");
  assert.equal(result.events[0].externalEventId, "oddsio-1");
  assert.deepEqual(result.events[0].bookmakers[0].markets.map(market => market.key), ["h2h", "spreads", "totals"]);
  assert.equal(result.events[0].bookmakers[0].markets.filter(market => market.key === "h2h").length, 1);
  assert.equal(calls.oddsApiIo, 3);
}

function testOddsApiIoEventMatchingRequiresTeamsAndTime() {
  const f = fixture();
  const good = matchOddsApiIoEvent(f, oddsApiIoEvents(), { minConfidence: 0.7, kickoffToleranceMinutes: 180 });
  const late = matchOddsApiIoEvent(f, [{ ...oddsApiIoEvents()[0], date: "2026-08-21T14:00:00Z" }], { minConfidence: 0.7, kickoffToleranceMinutes: 180 });
  const wrongTeam = matchOddsApiIoEvent(f, [{ ...oddsApiIoEvents()[0], home: "Liverpool FC" }], { minConfidence: 0.7, kickoffToleranceMinutes: 180 });
  assert.ok(good.event);
  assert.equal(late.event, null);
  assert.equal(late.diagnostic, "MATCH_NOT_FOUND");
  assert.equal(wrongTeam.event, null);
}

async function testNoOddsApiIoKeyIsNA() {
  const result = await oddsProviderOddsApiIo({
    request: async () => { throw new Error("should not request without key"); },
    oddsApiIoKey: "",
    fixtures: [fixture()],
    root: root()
  });
  assert.equal(result.status, "N/A");
  assert.equal(result.meta.reason, "NOT_CONFIGURED");
  assert.equal(result.requestsUsed, 0);
}

async function testOddsApiIoRequiresConfiguredBookmakersForOdds() {
  const tmp = root();
  const calls = { secondary: 0, oddsApiIo: 0 };
  const result = await oddsProviderOddsApiIo({
    request: createRequest({ oddsApiIo: "ok", calls }),
    oddsApiIoKey: "odds-api-io-key",
    oddsApiIoBookmakers: "",
    fixtures: [fixture()],
    root: tmp,
    now: new Date("2026-08-20T10:00:00Z"),
    cacheMinutes: 10
  });
  assert.equal(result.status, "N/A");
  assert.equal(result.error.code, "BOOKMAKERS_NOT_CONFIGURED");
  assert.equal(result.meta.reason, "BOOKMAKERS_NOT_CONFIGURED");
  assert.equal(result.meta.eventRequests, 1);
  assert.equal(result.meta.oddsBatchRequests, 0);
  assert.equal(calls.oddsApiIo, 1);
}

async function testOddsApiIoInvalidBookmakerIsUnavailable() {
  const tmp = root();
  let calls = 0;
  const result = await oddsProviderOddsApiIo({
    request: async url => {
      calls += 1;
      const value = String(url);
      if (value.includes("/events")) return oddsApiIoEvents();
      if (value.includes("/odds/multi")) throw new Error("400: GGbet is not a valid bookmaker, use /v3/bookmakers to get a list of valid bookmakers");
      return [];
    },
    oddsApiIoKey: "odds-api-io-key",
    oddsApiIoBookmakers: "GGbet,Bet365",
    fixtures: [fixture()],
    root: tmp,
    now: new Date("2026-08-20T10:00:00Z"),
    cacheMinutes: 10
  });
  assert.equal(result.status, "N/A");
  assert.equal(result.error.code, "BOOKMAKER_INVALID");
  assert.equal(result.meta.reason, "BOOKMAKER_INVALID");
  assert.equal(result.meta.requestsUsed, 2);
  assert.equal(result.meta.oddsBatchRequests, 1);
  assert.equal(calls, 2);
}

async function testOddsApiIoBookmakerSelectionMismatchIsUnavailable() {
  const tmp = root();
  const result = await oddsProviderOddsApiIo({
    request: async url => {
      const value = String(url);
      if (value.includes("/events")) return oddsApiIoEvents();
      if (value.includes("/odds/multi")) {
        throw new Error("403: Access denied. You're allowed max 2 bookmakers. Allowed: bet365 NJ, GG.bet.");
      }
      return [];
    },
    oddsApiIoKey: "odds-api-io-key",
    oddsApiIoBookmakers: "Bet365,GG.bet",
    fixtures: [fixture()],
    root: tmp,
    now: new Date("2026-08-20T10:00:00Z"),
    cacheMinutes: 10
  });
  assert.equal(result.status, "N/A");
  assert.equal(result.error.code, "BOOKMAKER_SELECTION_MISMATCH");
  assert.equal(result.meta.reason, "BOOKMAKER_SELECTION_MISMATCH");
  assert.equal(result.meta.requestsUsed, 2);
  assert.equal(result.meta.oddsBatchRequests, 1);
}

async function testSecondaryFallbackAndProvenance() {
  const tmp = root();
  const calls = { secondary: 0 };
  const result = await aggregateMarket({
    request: createRequest({ primary: "quota", calls }),
    config: config(tmp),
    sportKey: "soccer_epl",
    fixtures: [fixture()],
    marketCache: createMarketCache(tmp),
    now: new Date("2026-08-20T10:05:00Z")
  });

  const event = result.byFixtureId["fixture-1"];
  assert.equal(event.marketMeta.source, "API_FOOTBALL");
  assert.equal(event.marketMeta.sourcePriority, "SECONDARY");
  assert.equal(event.marketMeta.fallbackReason, "primary:QUOTA");
  assert.equal(result.meta.secondaryRequestsUsed, 1);
  assert.equal(result.meta.secondaryFixturesReceived, 1);
  assert.equal(result.meta.usageCounts.SECONDARY, 1);
  assert.equal(calls.secondary, 1);
}

async function testSecondaryRawCacheReused() {
  const tmp = root();
  const calls = { secondary: 0 };
  const cfg = config(tmp);
  const args = {
    request: createRequest({ primary: "quota", calls }),
    apiFootballKey: cfg.apiFootballKey,
    fixtures: [fixture()],
    root: tmp,
    now: new Date("2026-08-20T10:00:00Z"),
    cacheMinutes: 180
  };
  const first = await oddsProviderSecondary(args);
  const second = await oddsProviderSecondary({ ...args, now: new Date("2026-08-20T10:10:00Z") });
  assert.equal(first.requestsUsed, 1);
  assert.equal(second.requestsUsed, 0);
  assert.equal(calls.secondary, 1);
}

async function testApiFootballPlanErrorIsUnavailable() {
  const tmp = root();
  const calls = { secondary: 0 };
  const result = await oddsProviderSecondary({
    request: createRequest({
      primary: "quota",
      secondaryPayload: {
        get: "odds",
        errors: { plan: "Free plans do not have access to this season, try from 2022 to 2024." },
        results: 0,
        response: []
      },
      calls
    }),
    apiFootballKey: config(tmp).apiFootballKey,
    fixtures: [fixture()],
    root: tmp,
    now: new Date("2026-08-20T10:00:00Z"),
    cacheMinutes: 180
  });
  assert.equal(result.status, "N/A");
  assert.equal(result.error.code, "PLAN_SEASON_WINDOW");
  assert.equal(result.meta.reason, "PLAN_SEASON_WINDOW");
  assert.equal(result.meta.errors[0].reason, "PLAN_SEASON_WINDOW");
  assert.equal(result.events.length, 0);
  assert.equal(result.meta.errors[0].apiErrors[0].code, "plan");
  assert.equal(calls.secondary, 1);
}

async function testPrimaryCoverageSkipsFallbackProviders() {
  const tmp = root();
  const calls = { secondary: 0 };
  const result = await aggregateMarket({
    request: createRequest({ primary: "ok", calls }),
    config: config(tmp),
    sportKey: "soccer_epl",
    fixtures: [fixture()],
    marketCache: createMarketCache(tmp),
    now: new Date("2026-08-20T10:05:00Z")
  });
  const event = result.byFixtureId["fixture-1"];
  assert.equal(event.marketMeta.sourcePriority, "PRIMARY");
  assert.equal(result.diagnostics["fixture-1"].marketAgreement, null);
  assert.equal(result.meta.usageCounts.PRIMARY, 1);
  assert.equal(result.meta.oddsApiIoRequestsUsed, 0);
  assert.equal(result.meta.secondaryRequestsUsed, 0);
  assert.equal(calls.oddsApiIo || 0, 0);
  assert.equal(calls.secondary, 0);
}

async function testPrimaryQuotaFallsBackToOddsApiIo() {
  const tmp = root();
  const calls = { secondary: 0, oddsApiIo: 0 };
  const result = await aggregateMarket({
    request: createRequest({ primary: "quota", oddsApiIo: "ok", calls }),
    config: config(tmp, { oddsApiIoKey: "odds-api-io-key", oddsApiIoBookmakers: "OddsIoBook" }),
    sportKey: "soccer_epl",
    fixtures: [fixture()],
    marketCache: createMarketCache(tmp),
    now: new Date("2026-08-20T10:05:00Z")
  });
  const event = result.byFixtureId["fixture-1"];
  assert.equal(event.marketMeta.source, "ODDS_API_IO");
  assert.equal(event.marketMeta.sourcePriority, "ODDS_API_IO");
  assert.equal(event.marketMeta.fallbackReason, "primary:QUOTA");
  assert.equal(event.externalEventId, "oddsio-1");
  assert.equal(result.meta.usageCounts.ODDS_API_IO, 1);
  assert.equal(result.meta.oddsApiIoRequestsUsed, 2);
  assert.equal(result.meta.oddsApiIoMatchedFixtures, 1);
}

async function testPrimaryQuotaBackoffSharedAcrossCompetitions() {
  const tmp = root();
  const calls = { primary: 0, secondary: 0, oddsApiIo: 0 };
  const fallbackRequest = createRequest({ primary: "quota", oddsApiIo: "ok", calls });
  const request = async url => {
    if (String(url).includes("the-odds-api")) {
      calls.primary += 1;
      throw new Error("OUT_OF_USAGE_CREDITS");
    }
    return fallbackRequest(url);
  };
  const cfg = config(tmp, { oddsApiIoKey: "odds-api-io-key", oddsApiIoBookmakers: "OddsIoBook" });
  const cache = createMarketCache(tmp);
  const first = await aggregateMarket({
    request,
    config: cfg,
    sportKey: "soccer_epl",
    fixtures: [fixture("f1")],
    marketCache: cache,
    now: new Date("2026-08-20T10:00:00Z")
  });
  const second = await aggregateMarket({
    request,
    config: cfg,
    sportKey: "soccer_spain_la_liga",
    fixtures: [{ ...fixture("f2"), competitionCode: "PD" }],
    marketCache: cache,
    now: new Date("2026-08-20T10:01:00Z")
  });
  assert.equal(calls.primary, 1);
  assert.equal(first.meta.primaryBackoff.reason, "QUOTA");
  assert.equal(second.meta.primaryBackoff.reason, "QUOTA_BACKOFF");
  assert.equal(second.providerResults[0].error.code, "QUOTA_BACKOFF");
  assert.equal(second.providerResults[0].meta.requestsUsed, 0);
}

async function testOddsApiIoQuotaFallsBackToApiFootball() {
  const tmp = root();
  const calls = { secondary: 0, oddsApiIo: 0 };
  const result = await aggregateMarket({
    request: createRequest({ primary: "quota", oddsApiIo: "quota", calls }),
    config: config(tmp, { oddsApiIoKey: "odds-api-io-key", oddsApiIoBookmakers: "OddsIoBook" }),
    sportKey: "soccer_epl",
    fixtures: [fixture()],
    marketCache: createMarketCache(tmp),
    now: new Date("2026-08-20T10:05:00Z")
  });
  const event = result.byFixtureId["fixture-1"];
  assert.equal(event.marketMeta.source, "API_FOOTBALL");
  assert.equal(event.marketMeta.sourcePriority, "SECONDARY");
  assert.equal(result.meta.oddsApiIoStatus, "QUOTA");
  assert.equal(result.meta.usageCounts.SECONDARY, 1);
  assert.equal(calls.secondary, 1);
}

async function testOddsApiIoProvenanceAndCacheRevision() {
  const tmp = root();
  const calls = { secondary: 0, oddsApiIo: 0 };
  const cache = createMarketCache(tmp);
  await aggregateMarket({
    request: createRequest({ primary: "quota", oddsApiIo: "ok", calls }),
    config: config(tmp, { oddsApiIoKey: "odds-api-io-key", oddsApiIoBookmakers: "OddsIoBook" }),
    sportKey: "soccer_epl",
    fixtures: [fixture()],
    marketCache: cache,
    now: new Date("2026-08-20T10:05:00Z")
  });
  const rows = cache.readQuotes().filter(row => row.source === "ODDS_API_IO");
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.bookmaker === "OddsIoBook"));
  assert.ok(rows.every(row => row.observedAt));
}

async function testConflictingFixtureIdentityRejected() {
  const tmp = root();
  const calls = { secondary: 0 };
  const result = await aggregateMarket({
    request: createRequest({
      primary: "quota",
      secondaryPayload: apiFootballPayload("Liverpool", "Everton"),
      calls
    }),
    config: config(tmp),
    sportKey: "soccer_epl",
    fixtures: [fixture()],
    marketCache: createMarketCache(tmp),
    now: new Date("2026-08-20T10:05:00Z")
  });
  assert.equal(result.byFixtureId["fixture-1"], undefined);
  assert.equal(result.diagnostics["fixture-1"].secondaryDiagnostic, "MATCH_LOW_CONFIDENCE");
  assert.equal(result.meta.fixturesRejectedByMatching, 1);
}

async function testBothUnavailableFallsBackToFreshCache() {
  const tmp = root();
  const cache = createMarketCache(tmp);
  cache.appendFixtureOdds({
    fixture: fixture(),
    oddsEvent: primaryEvent(),
    source: "odds.primary",
    observedAt: "2026-08-20T10:00:00Z",
    matchingConfidence: 1,
    revisionThreshold: 0.02
  });
  const calls = { secondary: 0 };
  const result = await aggregateMarket({
    request: createRequest({ primary: "error", secondary: "error", calls }),
    config: config(tmp),
    sportKey: "soccer_epl",
    fixtures: [fixture()],
    marketCache: cache,
    now: new Date("2026-08-20T10:05:00Z")
  });
  assert.equal(result.byFixtureId["fixture-1"].marketMeta.source, "market.cache");
  assert.equal(result.meta.usageCounts.CACHE, 1);
}

function testClvSourcePreserved() {
  const clv = calculateClv({
    signal: {
      fixtureId: "f1",
      market: "h2h",
      selection: "home",
      kickoff: "2026-08-20T14:00:00Z",
      officialOdds: 2,
      officialBookmaker: "BookA",
      marketSource: "API_FOOTBALL",
      marketObservedAt: "2026-08-20T10:00:00Z"
    },
    closing: {
      odds: 1.95,
      observedAt: "2026-08-20T13:45:00Z",
      ageBeforeKickoffMinutes: 15,
      source: "API_FOOTBALL",
      bookmaker: "BookA"
    }
  });
  assert.equal(clv.marketSource, "API_FOOTBALL");
  assert.equal(clv.quality, "HIGH");
}

await testSecondaryFallbackAndProvenance();
await testSecondaryRawCacheReused();
await testApiFootballPlanErrorIsUnavailable();
await testOddsApiIoNormalizationAndBatching();
testOddsApiIoEventMatchingRequiresTeamsAndTime();
await testNoOddsApiIoKeyIsNA();
await testOddsApiIoRequiresConfiguredBookmakersForOdds();
await testOddsApiIoInvalidBookmakerIsUnavailable();
await testOddsApiIoBookmakerSelectionMismatchIsUnavailable();
await testPrimaryCoverageSkipsFallbackProviders();
await testPrimaryQuotaFallsBackToOddsApiIo();
await testPrimaryQuotaBackoffSharedAcrossCompetitions();
await testOddsApiIoQuotaFallsBackToApiFootball();
await testOddsApiIoProvenanceAndCacheRevision();
await testConflictingFixtureIdentityRejected();
await testBothUnavailableFallsBackToFreshCache();
testClvSourcePreserved();

console.log("Stage 8A tests OK: secondary API-Football fallback, provenance, cache and agreement diagnostics.");
