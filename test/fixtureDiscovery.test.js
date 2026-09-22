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

// Diagnostic-reclassification regression (STATUS: OBSERVE fix): an empty
// API-Football result used to always collapse into one undifferentiated
// "API_FOOTBALL_EMPTY" reason. discoverFixtures now reads the .diagnostics
// counters the connector attaches (see apiFootball.js) and reports which of
// the (up to) four distinct scenarios actually happened. No filtering rule
// changes here -- only which reason string gets reported for an already-empty
// result.
function emptyArrayWith(diagnostics) { const a = []; a.diagnostics = diagnostics; return a; }

test("events=0 -> API_FOOTBALL_NO_EVENTS", async () => {
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now,
    apiFootball: async () => emptyArrayWith({ events: 0, futureEvents: 0, supportedFixtures: 0 }),
    footballData: async () => []
  });
  assert.equal(result.health.reason, "API_FOOTBALL_NO_EVENTS");
  assert.deepEqual(result.fixtures, []);
});

test("events > 0, futureEvents = 0 -> API_FOOTBALL_NO_FUTURE_EVENTS", async () => {
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now,
    apiFootball: async () => emptyArrayWith({ events: 12, futureEvents: 0, supportedFixtures: 0 }),
    footballData: async () => []
  });
  assert.equal(result.health.reason, "API_FOOTBALL_NO_FUTURE_EVENTS");
});

test("futureEvents > 0, supportedFixtures = 0 -> API_FOOTBALL_NO_SUPPORTED_FIXTURES", async () => {
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now,
    apiFootball: async () => emptyArrayWith({ events: 410, futureEvents: 394, supportedFixtures: 0 }),
    footballData: async () => []
  });
  assert.equal(result.health.reason, "API_FOOTBALL_NO_SUPPORTED_FIXTURES");
});

test("supportedFixtures > 0 but discoverFixtures' own usableFixture filter removes them all -> API_FOOTBALL_NO_USABLE_FIXTURES (the real 4th scenario)", async () => {
  // A "supported" fixture missing a home/away name -- usableFixture()
  // rejects it independently of API-Football's own competitionCode mapping.
  const unusable = emptyArrayWith({ events: 5, futureEvents: 5, supportedFixtures: 1 });
  unusable.push({ id: "x", competitionCode: "PD", utcDate: "2026-08-27T18:00:00Z", home: "", away: "Beta" });
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now,
    apiFootball: async () => unusable,
    footballData: async () => []
  });
  assert.equal(result.health.reason, "API_FOOTBALL_NO_USABLE_FIXTURES");
});

test("supportedFixtures > 0 and actually usable -> normal fixtures, no empty reason at all", async () => {
  const withFixture = emptyArrayWith({ events: 3, futureEvents: 2, supportedFixtures: 1 });
  withFixture.push({ ...cached });
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now,
    apiFootball: async () => withFixture,
    footballData: async () => []
  });
  assert.equal(result.health.status, "OK");
  assert.equal(result.health.reason, null);
  assert.equal(result.fixtures.length, 1);
});

test("no diagnostics attached (legacy/test double) falls back to the old undifferentiated reason, unchanged", async () => {
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now,
    apiFootball: async () => [],
    footballData: async () => []
  });
  assert.equal(result.health.reason, "API_FOOTBALL_EMPTY");
});

test("provider error semantics are completely unchanged by the diagnostic fix", async () => {
  const result = await discoverFixtures({
    apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now,
    apiFootball: async () => { const error = new Error("API-Football: DAILY LIMIT"); error.code = "DAILY_LIMIT"; throw error; },
    footballData: async () => []
  });
  assert.equal(result.health.reason, "DAILY_LIMIT");
  assert.equal(result.health.status, "DEGRADED");
});

test("fixtures array is IDENTICAL for the same underlying API response whether or not diagnostics are attached -- only health.reason/telemetry differ", async () => {
  const rawFixtureRow = { ...cached };
  const withoutDiagnostics = [rawFixtureRow];
  const withDiagnostics = emptyArrayWith({ events: 1, futureEvents: 1, supportedFixtures: 1 });
  withDiagnostics.push(rawFixtureRow);

  const a = await discoverFixtures({ apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now, apiFootball: async () => withoutDiagnostics, footballData: async () => [] });
  const b = await discoverFixtures({ apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now, apiFootball: async () => withDiagnostics, footballData: async () => [] });
  assert.deepEqual(a.fixtures, b.fixtures, "the returned fixtures must be identical regardless of the diagnostics side-channel");

  // Now the empty-result case: same empty content, reason differs precisely
  // because diagnostics are/aren't present -- proving the fixtures value
  // itself never depends on diagnostics, only the reported reason does.
  const emptyNoDiag = await discoverFixtures({ apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now, apiFootball: async () => [], footballData: async () => [] });
  const emptyWithDiag = await discoverFixtures({ apiKey: "secret", footballDataToken: "secret", horizonHours: 24, previousResults: [], now, apiFootball: async () => emptyArrayWith({ events: 410, futureEvents: 394, supportedFixtures: 0 }), footballData: async () => [] });
  assert.deepEqual(emptyNoDiag.fixtures, emptyWithDiag.fixtures);
  assert.notEqual(emptyNoDiag.health.reason, emptyWithDiag.health.reason);
});
