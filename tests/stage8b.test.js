import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runXgControlledExperiment } from "../src/experiments/xgExperiment.js";
import { buildModel } from "../src/model/probability.js";
import { normalizeSportmonksFixture, fetchSportmonksFixtureXg } from "../src/providers/xg/sportmonks.js";
import { normalizeTheStatsApiMatchStats, fetchTheStatsApiFixtureXg } from "../src/providers/xg/theStatsApi.js";
import { createXgCache } from "../src/providers/xg/xgCache.js";
import { XG_STATUS } from "../src/providers/xg/xgProvider.js";

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fvm-stage8b-"));
}

function fixture(id = "target", kickoff = "2026-08-20T14:00:00Z") {
  return {
    id,
    fixtureId: id,
    competition: "Premier League",
    competitionCode: "PL",
    utcDate: kickoff,
    homeId: 1,
    awayId: 2,
    homeTeamId: 1,
    awayTeamId: 2,
    home: "Alpha FC",
    away: "Beta FC"
  };
}

function xgRecord(id, kickoff, homeTeamId, awayTeamId, homeXg, awayXg, extra = {}) {
  return {
    fixtureId: id,
    externalFixtureId: `ext-${id}`,
    kickoff,
    competition: "Premier League",
    homeTeamId,
    awayTeamId,
    home: {
      xG: homeXg,
      npxG: extra.homeNpxG ?? null,
      xGA: extra.homeXGA ?? null
    },
    away: {
      xG: awayXg,
      npxG: extra.awayNpxG ?? null,
      xGA: extra.awayXGA ?? null
    },
    source: "TEST_XG",
    observedAt: "2026-08-18T10:00:00Z",
    status: "OK",
    coverage: "FULL",
    metricVersion: "actual-xg-v1"
  };
}

function sportmonksPayload() {
  return {
    data: {
      id: 9001,
      starting_at: "2026-08-18 18:00:00",
      league: { name: "Premier League" },
      xgfixture: [
        { location: "home", type: { code: "expected-goals" }, data: { value: 1.45 } },
        { location: "away", type: { code: "expected-goals" }, data: { value: 0.85 } },
        { location: "home", type: { code: "expected-non-penalty-goals" }, data: { value: 1.1 } },
        { location: "away", type: { code: "expected-goals-against" }, data: { value: 1.45 } }
      ]
    }
  };
}

function testSportmonksNormalizationAndPartialNulls() {
  const record = normalizeSportmonksFixture(sportmonksPayload(), fixture("sm-1"));
  assert.equal(record.source, "SPORTMONKS_XG");
  assert.equal(record.externalFixtureId, "9001");
  assert.equal(record.home.xG, 1.45);
  assert.equal(record.home.npxG, 1.1);
  assert.equal(record.home.xGA, null);
  assert.equal(record.away.xGA, 1.45);
  assert.equal(record.coverage, "FULL");
}

function testTheStatsApiNormalization() {
  const record = normalizeTheStatsApiMatchStats({
    data: {
      match_id: "mt_1",
      overview: { expected_goals: { all: { home: 2.1, away: 0.9 } } },
      np_expected_goals: { all: { home: 1.8, away: 0.7 } }
    }
  }, fixture("ts-1"));
  assert.equal(record.source, "THESTATSAPI_XG");
  assert.equal(record.home.xG, 2.1);
  assert.equal(record.away.xGA, 2.1);
  assert.equal(record.coverage, "FULL");
}

function testDeduplication() {
  const cache = createXgCache(root());
  const record = xgRecord("1", "2026-08-01T12:00:00Z", 1, 3, 1.2, 0.6);
  assert.equal(cache.appendMatchXg(record).appended, true);
  assert.equal(cache.appendMatchXg(record).appended, false);
  assert.equal(cache.readRecords().length, 1);
}

function testTemporalLeakageAndFutureExclusion() {
  const cache = createXgCache(root());
  cache.appendMatchXg(xgRecord("past", "2026-08-10T12:00:00Z", 1, 3, 1.0, 0.5));
  cache.appendMatchXg(xgRecord("target", "2026-08-20T14:00:00Z", 1, 2, 9.9, 9.9));
  cache.appendMatchXg(xgRecord("future", "2026-08-21T12:00:00Z", 2, 1, 8.8, 8.8));
  const records = cache.recordsBefore("2026-08-20T14:00:00Z");
  assert.deepEqual(records.map(record => record.fixtureId), ["past"]);
  const features = cache.featuresForFixture(fixture());
  assert.equal(features.home.sampleSize, 1);
  assert.equal(features.away.sampleSize, 0);
  assert.equal(features.home.rolling.xG3, 1.0);
}

function testRollingWindowsAndHomeAwaySplits() {
  const cache = createXgCache(root());
  for (let i = 1; i <= 10; i++) {
    const homeTeam = i % 2 === 0 ? 1 : 3;
    const awayTeam = i % 2 === 0 ? 4 : 1;
    cache.appendMatchXg(xgRecord(
      String(i),
      `2026-08-${String(i).padStart(2, "0")}T12:00:00Z`,
      homeTeam,
      awayTeam,
      i,
      i / 2,
      { homeNpxG: i - 0.1, awayNpxG: i / 2 - 0.1 }
    ));
  }
  const features = cache.featuresForFixture(fixture());
  assert.equal(features.home.sampleSize, 10);
  assert.equal(features.home.coverage, "FULL");
  assert.equal(features.home.rolling.xG3, (10 + 4.5 + 8) / 3);
  assert.equal(features.home.rolling.xG5, (10 + 4.5 + 8 + 3.5 + 6) / 5);
  assert.equal(features.home.rolling.npxG3, (9.9 + 4.4 + 7.9) / 3);
  assert.equal(features.home.homeAway.home.sampleSize, 5);
  assert.equal(features.home.homeAway.away.sampleSize, 5);
  assert.ok(Number.isFinite(features.home.derived.xGTrend));
}

async function testProviderUnavailableStatuses() {
  const f = fixture();
  const sportmonks = await fetchSportmonksFixtureXg({ request: async () => [], sportmonksApiKey: "", fixture: f });
  const theStats = await fetchTheStatsApiFixtureXg({ request: async () => [], theStatsApiKey: "", fixture: f });
  assert.equal(sportmonks.status, XG_STATUS.NOT_CONFIGURED);
  assert.equal(theStats.status, XG_STATUS.NOT_CONFIGURED);
}

function testProductionProbabilityUnchangedByXg() {
  const f = fixture();
  const context = {
    standings: {
      standings: [{
        type: "TOTAL",
        table: [
          { team: { id: 1 }, playedGames: 6, points: 12, goalsFor: 10, goalsAgainst: 5, goalDifference: 5 },
          { team: { id: 2 }, playedGames: 6, points: 8, goalsFor: 7, goalsAgainst: 7, goalDifference: 0 }
        ]
      }]
    },
    matches: [
      { id: "1", utcDate: "2026-08-01T12:00:00Z", homeTeam: { id: 1 }, awayTeam: { id: 3 }, score: { fullTime: { home: 2, away: 0 } } },
      { id: "2", utcDate: "2026-08-02T12:00:00Z", homeTeam: { id: 4 }, awayTeam: { id: 1 }, score: { fullTime: { home: 1, away: 1 } } },
      { id: "3", utcDate: "2026-08-03T12:00:00Z", homeTeam: { id: 1 }, awayTeam: { id: 5 }, score: { fullTime: { home: 3, away: 1 } } },
      { id: "4", utcDate: "2026-08-01T12:00:00Z", homeTeam: { id: 2 }, awayTeam: { id: 6 }, score: { fullTime: { home: 1, away: 0 } } },
      { id: "5", utcDate: "2026-08-02T12:00:00Z", homeTeam: { id: 7 }, awayTeam: { id: 2 }, score: { fullTime: { home: 2, away: 1 } } },
      { id: "6", utcDate: "2026-08-03T12:00:00Z", homeTeam: { id: 2 }, awayTeam: { id: 8 }, score: { fullTime: { home: 0, away: 0 } } }
    ]
  };
  const first = buildModel(f, context);
  const cache = createXgCache(root());
  cache.appendMatchXg(xgRecord("xg-1", "2026-08-10T12:00:00Z", 1, 2, 5.5, 0.1));
  cache.featuresForFixture(f);
  const second = buildModel(f, context);
  assert.deepEqual(second.model, first.model);
}

function testExperimentBlockedWithoutRealSample() {
  const result = runXgControlledExperiment([], createXgCache(root()), { minimumXgSample: 2 });
  assert.equal(result.status, "INSUFFICIENT_DATA");
}

testSportmonksNormalizationAndPartialNulls();
testTheStatsApiNormalization();
testDeduplication();
testTemporalLeakageAndFutureExclusion();
testRollingWindowsAndHomeAwaySplits();
await testProviderUnavailableStatuses();
testProductionProbabilityUnchangedByXg();
testExperimentBlockedWithoutRealSample();

console.log("Stage 8B tests OK: xG provider contract, cache, temporal safety, features and diagnostic-only experiment.");
