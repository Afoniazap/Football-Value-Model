import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildModel } from "../src/model/probability.js";
import { classify } from "../src/decision/classify.js";
import { matchOddsEvent } from "../src/market/oddsMatching.js";
import { aggregateMarket } from "../src/providers/market/aggregateMarket.js";
import { createMarketCache, freshnessStatus } from "../src/providers/market/marketCache.js";
import { buildShadowComparison } from "../src/shadow/comparison.js";
import { createLivePreMatchContext } from "../src/shadow/liveContext.js";

const config = {
  oddsApiKey: "token",
  oddsRegion: "eu",
  oddsFreshMinutes: 15,
  oddsStaleMinutes: 60,
  oddsRevisionThreshold: 0.02,
  marketMatchMinConfidence: 0.7,
  minDataQuality: 50,
  minEdgePercent: 3
};

function fixture(id = "fixture-1") {
  return {
    id,
    competitionCode: "TL",
    competition: "Test League",
    utcDate: "2026-01-10T12:00:00Z",
    home: "Alpha FC",
    away: "Beta FC",
    homeId: 1,
    awayId: 2
  };
}

function oddsEvent(home = 2.1, draw = 3.2, away = 3.4, homeTeam = "Alpha FC", awayTeam = "Beta FC") {
  return {
    id: "event-1",
    sport_key: "soccer_test",
    commence_time: "2026-01-10T12:00:00Z",
    home_team: homeTeam,
    away_team: awayTeam,
    bookmakers: [{
      title: "BookA",
      markets: [{
        key: "h2h",
        outcomes: [
          { name: homeTeam, price: home },
          { name: "Draw", price: draw },
          { name: awayTeam, price: away }
        ]
      }]
    }]
  };
}

function context() {
  const matches = [
    [1, 3, 2, 0], [4, 1, 1, 1], [1, 5, 3, 1], [6, 1, 0, 1], [1, 7, 2, 2],
    [2, 8, 1, 0], [9, 2, 2, 1], [2, 10, 0, 0], [11, 2, 1, 2], [2, 12, 2, 2]
  ].map((row, index) => ({
    id: String(index + 1),
    utcDate: `2026-01-${String((index % 5) + 1).padStart(2, "0")}T12:00:00Z`,
    homeTeam: { id: row[0], name: `Team ${row[0]}` },
    awayTeam: { id: row[1], name: `Team ${row[1]}` },
    score: { fullTime: { home: row[2], away: row[3] } }
  }));
  return createLivePreMatchContext({
    standings: {
      standings: [{
        type: "TOTAL",
        table: [
          { team: { id: 1 }, playedGames: 5, points: 11, goalsFor: 9, goalsAgainst: 4, goalDifference: 5 },
          { team: { id: 2 }, playedGames: 5, points: 8, goalsFor: 6, goalsAgainst: 5, goalDifference: 1 }
        ]
      }]
    },
    matches
  });
}

function tempCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-market-"));
  return createMarketCache(root);
}

function testFreshnessStatuses() {
  const now = "2026-01-10T12:00:00Z";
  assert.equal(freshnessStatus("2026-01-10T11:50:00Z", now, config).status, "FRESH");
  assert.equal(freshnessStatus("2026-01-10T11:30:00Z", now, config).status, "STALE");
  assert.equal(freshnessStatus("2026-01-10T10:30:00Z", now, config).status, "EXPIRED");
}

function testDuplicateAndChangedOddsRevision() {
  const cache = tempCache();
  const f = fixture();
  cache.appendFixtureOdds({ fixture: f, oddsEvent: oddsEvent(2.1), source: "odds.primary", observedAt: "2026-01-10T11:50:00Z", matchingConfidence: 1, revisionThreshold: 0.02 });
  cache.appendFixtureOdds({ fixture: f, oddsEvent: oddsEvent(2.11), source: "odds.primary", observedAt: "2026-01-10T11:55:00Z", matchingConfidence: 1, revisionThreshold: 0.02 });
  assert.equal(cache.readQuotes().length, 3);
  cache.appendFixtureOdds({ fixture: f, oddsEvent: oddsEvent(2.13), source: "odds.primary", observedAt: "2026-01-10T11:58:00Z", matchingConfidence: 1, revisionThreshold: 0.02 });
  assert.equal(cache.readQuotes().length, 4);
  assert.ok(cache.readQuotes().some(row => row.revision === 2));
}

async function testQuotaFallbackToFreshCache() {
  const cache = tempCache();
  const f = fixture();
  cache.appendFixtureOdds({ fixture: f, oddsEvent: oddsEvent(), source: "odds.primary", observedAt: "2026-01-10T11:55:00Z", matchingConfidence: 1, revisionThreshold: 0.02 });
  const result = await aggregateMarket({
    request: async () => { throw new Error("OUT_OF_USAGE_CREDITS"); },
    config,
    sportKey: "soccer_test",
    fixtures: [f],
    marketCache: cache,
    now: new Date("2026-01-10T12:00:00Z")
  });
  assert.equal(result.byFixtureId[f.id].marketMeta.source, "market.cache");
  assert.equal(result.byFixtureId[f.id].marketMeta.freshness, "FRESH");
  assert.equal(result.meta.primaryBackoff.reason, "QUOTA");
}

async function testExpiredCacheCannotCreateValue() {
  const cache = tempCache();
  const f = fixture();
  cache.appendFixtureOdds({ fixture: f, oddsEvent: oddsEvent(), source: "odds.primary", observedAt: "2026-01-10T10:00:00Z", matchingConfidence: 1, revisionThreshold: 0.02 });
  const result = await aggregateMarket({
    request: async () => { throw new Error("OUT_OF_USAGE_CREDITS"); },
    config,
    sportKey: "soccer_test",
    fixtures: [f],
    marketCache: cache,
    now: new Date("2026-01-10T12:00:00Z")
  });
  assert.equal(result.byFixtureId[f.id], undefined);
}

function testLowConfidenceMatchRejected() {
  const matched = matchOddsEvent(fixture(), [oddsEvent(2.1, 3.2, 3.4, "Gamma FC", "Delta FC")], 0.9);
  assert.equal(matched.event, null);
  assert.equal(matched.diagnostic, "MATCH_LOW_CONFIDENCE");
}

function testNoProviderStillAllowsProbabilitiesAndShadow() {
  const f = fixture();
  const c = context();
  const baseline = classify(buildModel(f, c), null, config);
  const shadow = buildShadowComparison({
    fixture: f,
    context: c,
    baseline,
    oddsEvent: null,
    config,
    providerHealth: { odds: { status: "QUOTA" } }
  });
  assert.ok(baseline.model);
  assert.ok(shadow.challenger.probabilities);
  assert.equal(shadow.challenger.market.status, "N/A");
}

testFreshnessStatuses();
testDuplicateAndChangedOddsRevision();
await testQuotaFallbackToFreshCache();
await testExpiredCacheCannotCreateValue();
testLowConfidenceMatchRejected();
testNoProviderStillAllowsProbabilitiesAndShadow();

console.log("Stage 6 tests OK: market provider cache, freshness, revisions and quota fallback.");
