import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockerSummary } from "../src/diagnostics/blockers.js";
import { refreshCoverage } from "../src/diagnostics/coverage.js";
import { runDoctor } from "../src/diagnostics/doctor.js";
import { auditExactHorizon } from "../src/diagnostics/horizon.js";
import { operationalError } from "../src/diagnostics/operationalErrors.js";
import { buildRefreshTelemetry } from "../src/diagnostics/refreshTelemetry.js";
import { readinessState, startupReadiness } from "../src/diagnostics/readiness.js";
import { SourceStatus } from "../src/providers/providerResult.js";
import { createHistoryStore } from "../src/storage/history.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fvm-stage9-"));
}

function config(overrides = {}) {
  return {
    telegramToken: "token",
    footballDataToken: "fd",
    oddsApiKey: "",
    oddsApiIoKey: "odds-io",
    apiFootballKey: "",
    sportmonksApiKey: "",
    theStatsApiKey: "",
    allowedChatIds: new Set(["1"]),
    horizonHours: 24,
    refreshMinutes: 30,
    oddsFreshMinutes: 15,
    oddsStaleMinutes: 60,
    closingWindowMinutes: 30,
    marketMatchMinConfidence: 0.7,
    minDataQuality: 65,
    ...overrides
  };
}

function item(overrides = {}) {
  return {
    id: "100",
    category: "wait",
    odds: null,
    dataQuality: 50,
    confidence: 50,
    diagnostics: {
      market: { source: "NONE", freshness: "N/A" },
      dataQualityV2: { scoreNormalized: 50 },
      risk: { score: 60, redFlags: [{ code: "SOURCE_PARTIAL" }] },
      sanityWarnings: []
    },
    ...overrides
  };
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function testReadinessState() {
  const ready = readinessState({
    config: config(),
    providerHealth: { "football-data.fixtures": { status: SourceStatus.OK } },
    marketCoverage: { numerator: 1, denominator: 2 }
  });
  assert.equal(ready.status, "READY");

  const degraded = readinessState({
    config: config({ oddsApiIoKey: "" }),
    providerHealth: { "football-data.fixtures": { status: SourceStatus.OK } },
    marketCoverage: { numerator: 0, denominator: 2 }
  });
  assert.equal(degraded.status, "DEGRADED");

  const notReady = readinessState({
    config: config({ footballDataToken: "" }),
    providerHealth: {},
    marketCoverage: null
  });
  assert.equal(notReady.status, "NOT_READY");
  assert.equal(startupReadiness(config()).secrets.oddsApiIo, true);
}

function testExactHorizon() {
  const audit = auditExactHorizon([
    { id: "past", utcDate: "2026-08-18T09:59:59Z" },
    { id: "inside", utcDate: "2026-08-18T12:00:00Z" },
    { id: "edge", utcDate: "2026-08-19T10:00:00Z" },
    { id: "future", utcDate: "2026-08-19T10:00:01Z" }
  ], { now: new Date("2026-08-18T10:00:00Z"), horizonHours: 24 });
  assert.deepEqual(audit.accepted.map(row => row.id), ["inside", "edge"]);
  assert.deepEqual(audit.rejected.map(row => row.code), ["HORIZON_VIOLATION", "HORIZON_VIOLATION"]);
}

function testCoverageAndBlockers() {
  const processed = [
    item(),
    item({
      id: "101",
      category: "near",
      odds: { home: 2, draw: 3, away: 4 },
      candidate: { edge: 2, ev: 1 },
      diagnostics: {
        market: { source: "ODDS_API_IO", freshness: "FRESH", observedAt: "2026-08-18T10:00:00Z" },
        dataQualityV2: { scoreNormalized: 80 },
        risk: { score: 90, redFlags: [] },
        apiFootball: { meta: { apiFixtureId: 9 }, injuryCount: 1, lineupsCount: 2 },
        sanityWarnings: []
      }
    })
  ];
  const coverage = refreshCoverage({
    fixtures: processed,
    processed,
    providerHealth: { "api-football": { status: SourceStatus.PARTIAL }, xg: { status: SourceStatus.NA } }
  });
  assert.equal(coverage.market.numerator, 1);
  assert.equal(coverage.apiFootball.numerator, 1);
  assert.equal(coverage.lineups.numerator, 1);
  const blockers = blockerSummary(processed, config());
  assert.equal(blockers.counts.NO_MARKET, 1);
  assert.equal(blockers.counts.LOW_DQ, 1);
  assert.ok(blockers.counts.LOW_EDGE >= 1);
}

function testStructuredErrorsAndTelemetry() {
  const error = operationalError({ source: "odds-api-io", error: { message: "429 quota exceeded" }, refreshId: "r1" });
  assert.equal(error.code, "QUOTA");
  const telemetry = buildRefreshTelemetry({
    refreshId: "r1",
    startedAt: "2026-08-18T10:00:00Z",
    finishedAt: "2026-08-18T10:00:01Z",
    config: config(),
    fixturesFetched: 1,
    horizonAudit: { accepted: [item()], rejected: [] },
    contexts: { PL: {} },
    processed: [item()],
    providerResults: [{ source: "odds-api-io", status: SourceStatus.QUOTA, fetchedAt: "2026-08-18T10:00:00Z", error: { message: "429 quota" } }],
    providerHealth: {},
    marketAggregateMeta: { usageCounts: { NONE: 1 } },
    timings: { fixtures: 10 }
  });
  assert.equal(telemetry.durationMs, 1000);
  assert.equal(telemetry.errors[0].code, "QUOTA");
  assert.equal(telemetry.market.noMarketFixtures, 1);
}

function testRestartIdempotency() {
  const root = tmpRoot();
  const store = createHistoryStore(root);
  const signalItem = {
    id: "fixture-1",
    category: "value",
    competition: "PL",
    utcDate: "2026-08-20T12:00:00Z",
    home: "A",
    away: "B",
    candidate: { side: "P1", probability: 0.6, fairOdds: 1.67, odds: 2.1, edge: 12, ev: 26 },
    bookmaker: "Book",
    confidence: 75,
    dataQuality: 80,
    model: { home: 0.6, draw: 0.2, away: 0.2 },
    diagnostics: { market: { source: "ODDS_API_IO", freshness: "FRESH", observedAt: "2026-08-18T10:00:00Z" } }
  };
  const first = store.appendOfficialValueSignals({ analysisId: "a1", analysedAt: "2026-08-18T10:00:00Z", items: [signalItem], modelVersion: "test" });
  const second = createHistoryStore(root).appendOfficialValueSignals({ analysisId: "a2", analysedAt: "2026-08-18T10:01:00Z", items: [signalItem], modelVersion: "test" });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(createHistoryStore(root).readOfficialSignals().length, 1);
}

function testDoctorFindsProblems() {
  const root = tmpRoot();
  writeJsonl(path.join(root, "data", "history", "official-signals.jsonl"), [
    { signalId: "s1", kickoff: "2026-08-20T12:00:00Z" },
    { signalId: "s1", kickoff: "bad-date" }
  ]);
  writeJsonl(path.join(root, "data", "history", "settlements.jsonl"), [
    { signalId: "missing", settledAt: "2026-08-21T12:00:00Z" }
  ]);
  writeJsonl(path.join(root, "data", "market", "odds-history.jsonl"), [
    { quoteId: "q1", fixtureId: "f1", kickoff: "2026-08-18T10:00:00Z", market: "h2h", selection: "P1", bookmaker: "Book", odds: 2, source: "TEST", observedAt: "2026-08-18T10:01:00Z" },
    "{bad json"
  ]);
  const result = runDoctor(root);
  assert.equal(result.status, "FAIL");
  assert.ok(result.issues.some(issue => issue.code === "DUPLICATE_OFFICIAL_SIGNAL"));
  assert.ok(result.issues.some(issue => issue.code === "INVALID_JSONL"));
  assert.ok(result.issues.some(issue => issue.code === "POST_KICKOFF_MARKET"));
  assert.ok(result.issues.some(issue => issue.code === "SETTLEMENT_WITHOUT_SIGNAL"));
}

testReadinessState();
testExactHorizon();
testCoverageAndBlockers();
testStructuredErrorsAndTelemetry();
testRestartIdempotency();
testDoctorFindsProblems();

console.log("Stage 9 tests OK: readiness, horizon, coverage, blockers, errors, idempotency and doctor.");
