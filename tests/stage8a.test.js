import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateClv } from "../src/audit/clv.js";
import { aggregateMarket } from "../src/providers/market/aggregateMarket.js";
import { createMarketCache } from "../src/providers/market/marketCache.js";
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

function config(tmp) {
  return {
    root: tmp,
    oddsApiKey: "primary-key",
    oddsRegion: "eu",
    apiFootballKey: "secondary-key",
    apiFootballOddsCacheMinutes: 180,
    oddsFreshMinutes: 15,
    oddsStaleMinutes: 60,
    oddsRevisionThreshold: 0.02,
    marketMatchMinConfidence: 0.7
  };
}

function createRequest({ primary = "quota", secondary = "ok", secondaryPayload = apiFootballPayload(), calls }) {
  return async url => {
    const value = String(url);
    if (value.includes("the-odds-api")) {
      if (primary === "ok") return [primaryEvent()];
      if (primary === "error") throw new Error("500: primary error");
      throw new Error("OUT_OF_USAGE_CREDITS");
    }
    if (value.includes("api-sports")) {
      calls.secondary += 1;
      if (secondary === "error") throw new Error("429: quota");
      return secondaryPayload;
    }
    return [];
  };
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

async function testPrimaryWinsAndAgreementDiagnosticOnly() {
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
  assert.equal(result.diagnostics["fixture-1"].marketAgreement.home.sourceCount, 2);
  assert.equal(result.meta.usageCounts.PRIMARY, 1);
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
await testPrimaryWinsAndAgreementDiagnosticOnly();
await testConflictingFixtureIdentityRejected();
await testBothUnavailableFallsBackToFreshCache();
testClvSourcePreserved();

console.log("Stage 8A tests OK: secondary API-Football fallback, provenance, cache and agreement diagnostics.");
