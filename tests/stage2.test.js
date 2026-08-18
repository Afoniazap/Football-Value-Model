import assert from "node:assert/strict";
import { fetchApiFootballFixtureIntel } from "../src/providers/apiFootball.js";
import { fetchOddsForSport } from "../src/providers/odds.js";
import { SourceStatus } from "../src/providers/providerResult.js";
import { calculateDataQuality } from "../src/quality/dataQuality.js";
import { calculateRisk } from "../src/risk/riskScore.js";
import { runSanityChecks } from "../src/model/sanityChecks.js";

const fixture = {
  id: "100",
  utcDate: "2026-08-18T18:00:00Z",
  home: "Arsenal FC",
  away: "Chelsea FC",
  homeId: 1,
  awayId: 2
};

const context = {
  standings: {
    standings: [{
      type: "TOTAL",
      table: [
        { team: { id: 1 }, playedGames: 20 },
        { team: { id: 2 }, playedGames: 18 }
      ]
    }]
  },
  matches: [
    { homeTeam: { id: 1 }, awayTeam: { id: 3 } },
    { homeTeam: { id: 4 }, awayTeam: { id: 1 } },
    { homeTeam: { id: 1 }, awayTeam: { id: 5 } },
    { homeTeam: { id: 2 }, awayTeam: { id: 6 } },
    { homeTeam: { id: 7 }, awayTeam: { id: 2 } },
    { homeTeam: { id: 2 }, awayTeam: { id: 8 } }
  ]
};

async function testApiFootballFreePlanDate() {
  const request = async () => ({
    errors: { plan: "Free plans do not have access to this date" },
    response: []
  });
  const result = await fetchApiFootballFixtureIntel({
    request,
    apiFootballKey: "key",
    fixture
  });
  assert.equal(result.status, SourceStatus.NA);
  assert.equal(result.error.code, "PLAN_DATE_WINDOW");
}

async function testOddsQuota() {
  const request = async () => {
    throw new Error("402: OUT_OF_USAGE_CREDITS");
  };
  const result = await fetchOddsForSport({
    request,
    oddsApiKey: "key",
    oddsRegion: "eu",
    sportKey: "soccer_epl"
  });
  assert.equal(result.status, SourceStatus.QUOTA);
}

function testDqNormalizationWithNotConnectedXg() {
  const dq = calculateDataQuality({
    fixture,
    context,
    oddsEvent: { bookmakers: [] },
    apiFootballResult: {
      status: SourceStatus.NA,
      data: { injuries: [], lineups: [] },
      meta: { reason: "NOT_CONNECTED" }
    }
  });
  assert.equal(dq.components.find(x => x.name === "xgCoverage").status, SourceStatus.NA);
  assert.equal(dq.availableMax, 85);
  assert.ok(dq.scoreNormalized > 0);
}

function testSquadCoverage() {
  const dq = calculateDataQuality({
    fixture,
    context,
    oddsEvent: null,
    apiFootballResult: {
      status: SourceStatus.OK,
      data: { injuries: [{}], lineups: [{}, {}] },
      meta: {
        endpoints: [
          { endpoint: "injuries", status: SourceStatus.OK, count: 1 },
          { endpoint: "lineups", status: SourceStatus.OK, count: 2 }
        ]
      }
    }
  });
  assert.equal(dq.components.find(x => x.name === "squadCoverage").score, 10);
}

function testRiskWithNoLineupData() {
  const risk = calculateRisk({
    item: { model: { components: {} } },
    oddsEvent: null,
    apiFootballResult: {
      status: SourceStatus.NA,
      data: { injuries: [], lineups: [] }
    },
    providerStatuses: []
  });
  assert.equal(risk.score, 100);
  assert.equal(risk.redFlags[0].code, "LINEUPS_NOT_CONFIRMED");
  assert.equal(risk.redFlags[0].severity, "INFO");
}

function testSanityEvOver100() {
  const warnings = runSanityChecks({
    item: {
      model: { home: 0.4, draw: 0.3, away: 0.3 },
      candidate: { ev: 120, edge: 5, fairOdds: 2.5, probability: 0.4, key: "home" },
      marketProbability: { home: 0.35 }
    },
    dataQuality: { scoreNormalized: 80 },
    minDataQuality: 65
  });
  assert.ok(warnings.some(warning => warning.reason === "EV_OVER_100"));
}

function testSanityProbabilityHighLowDq() {
  const warnings = runSanityChecks({
    item: {
      model: { home: 0.91, draw: 0.05, away: 0.04 }
    },
    dataQuality: { scoreNormalized: 40 },
    minDataQuality: 65
  });
  assert.ok(warnings.some(warning => warning.reason === "PROBABILITY_HIGH_WITH_LOW_DQ"));
}

await testApiFootballFreePlanDate();
await testOddsQuota();
testDqNormalizationWithNotConnectedXg();
testSquadCoverage();
testRiskWithNoLineupData();
testSanityEvOver100();
testSanityProbabilityHighLowDq();

console.log("Stage 2 tests OK: API-Football statuses, DQ, risk and sanity diagnostics.");
