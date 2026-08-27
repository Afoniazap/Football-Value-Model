import test from "node:test";
import assert from "node:assert/strict";
import { discoverFixtures } from "../src/fixtures/discovery.js";

const now = Date.parse("2026-08-27T12:00:00Z");
const cached = {
  id: "api-1", apiFootballFixtureId: 1, apiFootballLeagueId: 3,
  competitionCode: "EL", competition: "UEFA Europa League", seasonStart: "2026",
  utcDate: "2026-08-27T18:00:00Z", home: "Alpha", away: "Beta", homeId: 10, awayId: 20
};

test("API-Football DAILY_LIMIT keeps cached fixtures and completes discovery", async () => {
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24,
    previousResults: [{ ...cached, category: "NO_BET", markets: [] }], now,
    apiFootball: async () => { const error = new Error("API-Football: DAILY LIMIT"); error.code = "DAILY_LIMIT"; throw error; },
    footballData: async () => []
  });
  assert.equal(result.health.status, "DEGRADED");
  assert.equal(result.health.reason, "DAILY_LIMIT");
  assert.equal(result.health.source, "CACHED_STATE");
  assert.equal(result.fixtures.length, 1);
  assert.equal(result.fixtures[0].apiFootballFixtureId, 1);
});

test("Football-Data supplements cached fixtures without duplicating the same match", async () => {
  const footballDataFixture = { ...cached, id: "fd-1", apiFootballFixtureId: null, apiFootballLeagueId: null };
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24,
    previousResults: [cached], now,
    apiFootball: async () => { const error = new Error("plan"); error.code = "PLAN"; throw error; },
    footballData: async () => [footballDataFixture, { ...footballDataFixture, id: "fd-2", home: "Gamma", away: "Delta", utcDate: "2026-08-27T20:00:00Z" }]
  });
  assert.equal(result.fixtures.length, 2);
  assert.equal(result.fixtures[0].id, "api-1");
  assert.equal(result.health.source, "CACHED_STATE+FOOTBALL_DATA");
});

test("expired cached fixtures are never reused", async () => {
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24,
    previousResults: [{ ...cached, utcDate: "2026-08-27T10:00:00Z" }], now,
    apiFootball: async () => { throw new Error("offline"); },
    footballData: async () => []
  });
  assert.deepEqual(result.fixtures, []);
  assert.equal(result.health.source, null);
});
