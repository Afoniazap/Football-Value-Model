import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateClv, findClosingQuote } from "../src/audit/clv.js";
import {
  fixedStakeProfitLoss,
  gradeAsianHandicap,
  gradeMarket,
  gradeOverUnder
} from "../src/audit/settlement.js";
import { cumulativeStatistics, dailyAudit } from "../src/audit/statistics.js";
import { createHistoryStore } from "../src/storage/history.js";
import { scoreFinishedShadow } from "../src/shadow/scoring.js";

function tempStore() {
  return createHistoryStore(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-stage7-")));
}

function valueItem(overrides = {}) {
  return {
    id: "fixture-1",
    competition: "Test League",
    utcDate: "2026-01-10T12:00:00Z",
    home: "Alpha",
    away: "Beta",
    category: "value",
    bookmaker: "BookA",
    confidence: 74,
    dataQuality: 80,
    candidate: {
      side: "home",
      probability: 0.55,
      fairOdds: 1.8181818,
      odds: 2.1,
      edge: 4.2,
      ev: 15.5
    },
    model: { home: 0.55, draw: 0.25, away: 0.2 },
    shadow: {
      challenger: { probabilities: { home: 0.5, draw: 0.29, away: 0.21 } }
    },
    diagnostics: {
      market: {
        source: "odds.primary",
        freshness: "FRESH",
        observedAt: "2026-01-10T11:40:00Z"
      },
      dataQualityV2: {
        scoreNormalized: 82,
        components: [{ name: "standings", score: 20, max: 20 }]
      },
      risk: { score: 18, redFlags: [] },
      providerHealth: { odds: { status: "OK" } }
    },
    ...overrides
  };
}

function issue(store, item = valueItem()) {
  store.appendOfficialValueSignals({
    analysisId: "analysis-1",
    analysedAt: "2026-01-10T11:45:00Z",
    items: [item],
    modelVersion: "fvm-v1-clean"
  });
  return store.readOfficialSignals()[0];
}

function testImmutableOfficialIssueAndNoDuplicateRefresh() {
  const store = tempStore();
  const item = valueItem();
  issue(store, item);
  store.appendOfficialValueSignals({
    analysisId: "analysis-1",
    analysedAt: "2026-01-10T11:50:00Z",
    items: [{ ...item, candidate: { ...item.candidate, odds: 2.4 } }],
    modelVersion: "fvm-v1-clean"
  });
  const signals = store.readOfficialSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].officialOdds, 2.1);
  assert.equal(store.readSignalEvents().filter(row => row.type === "ISSUED").length, 1);
}

function testKickoffLockAndPostKickoffIgnored() {
  const store = tempStore();
  const signal = issue(store);
  const locked = store.lockSignalsAtKickoff({
    now: "2026-01-10T12:01:00Z",
    latestBySignalId: {
      [signal.signalId]: {
        latestOdds: 3.5,
        bestSeenOdds: 3.5,
        marketObservedAt: "2026-01-10T12:00:05Z",
        modelProbability: 0.7,
        category: "value"
      }
    }
  });
  assert.equal(locked.length, 1);
  assert.equal(locked[0].latestPreKickoffOdds, 2.1);
  assert.equal(locked[0].lastMarketObservation, "2026-01-10T11:40:00Z");
  assert.equal(store.lockSignalsAtKickoff({ now: "2026-01-10T12:02:00Z" }).length, 0);
}

function testSettlementMarkets() {
  assert.equal(gradeMarket({ market: "h2h", selection: "home", homeGoals: 2, awayGoals: 1 }), "WIN");
  assert.equal(gradeOverUnder({ selection: "over", line: 2, homeGoals: 1, awayGoals: 1 }), "PUSH");
  assert.equal(gradeOverUnder({ selection: "over", line: 2.25, homeGoals: 1, awayGoals: 1 }), "HALF_LOSS");
  assert.equal(gradeOverUnder({ selection: "under", line: 2.75, homeGoals: 1, awayGoals: 2 }), "HALF_LOSS");
  assert.equal(gradeAsianHandicap({ selection: "home", line: -0.25, homeGoals: 1, awayGoals: 1 }), "HALF_LOSS");
  assert.equal(gradeAsianHandicap({ selection: "away", line: 0.25, homeGoals: 1, awayGoals: 1 }), "HALF_WIN");
}

function testFixedStakeAccounting() {
  assert.deepEqual(fixedStakeProfitLoss("WIN", 2.1), { stake: 1, returns: 2.1, netUnits: 1.1, roi: 1.1 });
  assert.deepEqual(fixedStakeProfitLoss("LOSS", 2.1), { stake: 1, returns: 0, netUnits: -1, roi: -1 });
  assert.deepEqual(fixedStakeProfitLoss("PUSH", 2.1), { stake: 1, returns: 1, netUnits: 0, roi: 0 });
  assert.equal(fixedStakeProfitLoss("HALF_WIN", 2).netUnits, 0.5);
  assert.equal(fixedStakeProfitLoss("HALF_LOSS", 2).netUnits, -0.5);
}

function testRepeatedSettlementNoDuplicatePLAndAudits() {
  const store = tempStore();
  const signal = issue(store);
  const result = {
    homeGoals: 2,
    awayGoals: 1,
    result: "H",
    resultFetchedAt: "2026-01-10T15:00:00Z"
  };
  const first = store.settleOfficialSignal({ signalId: signal.signalId, result, settledAt: "2026-01-10T15:01:00Z" });
  const second = store.settleOfficialSignal({ signalId: signal.signalId, result, settledAt: "2026-01-10T15:02:00Z" });
  assert.equal(first.netUnits, 1.1);
  assert.equal(second.netUnits, 1.1);
  assert.equal(store.readSettlements().length, 1);
  assert.equal(store.auditDaily("2026-01-10").settled, 1);
  assert.equal(store.auditCumulative().overall.roi, 1.1);
}

function testStatisticsExplainPendingAndOrphanedSettlements() {
  const signals = [{
    signalId: "s1",
    issuedAt: "2026-01-10T11:00:00Z",
    market: "h2h",
    marketSource: "ODDS_API_IO",
    officialOdds: 2.1,
    modelProbability: 0.55,
    competition: "Test League",
    DQ: { scoreNormalized: 80 },
    Risk: { score: 70 }
  }];
  const settlement = {
    signalId: "s1",
    status: "WIN",
    stake: 1,
    returns: 2.1,
    netUnits: 1.1,
    settledAt: "2026-01-11T15:00:00Z"
  };
  const cumulative = cumulativeStatistics({
    signals,
    settlements: [settlement, { ...settlement, signalId: "missing" }],
    shadowResults: []
  });
  assert.equal(cumulative.integrity.pending, 0);
  assert.equal(cumulative.integrity.settlementsWithoutSignal, 1);
  assert.equal(cumulative.bySource.ODDS_API_IO.officialBets, 1);
  assert.equal(cumulative.bySource.ODDS_API_IO.settledBets, 1);

  const daily = dailyAudit({
    date: "2026-01-10",
    signals,
    settlements: [settlement],
    shadowResults: []
  });
  assert.equal(daily.pending, 0);
  assert.equal(daily.officialValueIssued, 1);
}

function testClvValidAndNA() {
  const signal = {
    signalId: "s1",
    fixtureId: "f1",
    kickoff: "2026-01-10T12:00:00Z",
    market: "h2h",
    selection: "home",
    officialOdds: 2,
    officialBookmaker: "BookA",
    marketSource: "odds.primary",
    marketObservedAt: "2026-01-10T10:00:00Z"
  };
  const closing = findClosingQuote({
    signal,
    marketQuotes: [{
      fixtureId: "f1",
      market: "h2h",
      selection: "home",
      odds: 1.9,
      observedAt: "2026-01-10T11:45:00Z",
      source: "odds.primary",
      bookmaker: "BookA"
    }],
    closingWindowMinutes: 30
  });
  const clv = calculateClv({ signal, closing });
  assert.equal(clv.quality, "HIGH");
  assert.ok(Math.abs(clv.oddsClv - -0.05) < 1e-12);
  assert.equal(calculateClv({ signal, closing: null }).quality, "N/A");
}

function testShadowResultScoring() {
  const scored = scoreFinishedShadow({
    fixtureId: "f1",
    baselineProbability: { home: 0.6, draw: 0.25, away: 0.15 },
    challengerProbability: { home: 0.45, draw: 0.3, away: 0.25 }
  }, "H");
  assert.equal(scored.baselineTopPickCorrect, true);
  assert.ok(scored.baselineBrier < scored.challengerBrier);
}

testImmutableOfficialIssueAndNoDuplicateRefresh();
testKickoffLockAndPostKickoffIgnored();
testSettlementMarkets();
testFixedStakeAccounting();
testRepeatedSettlementNoDuplicatePLAndAudits();
testStatisticsExplainPendingAndOrphanedSettlements();
testClvValidAndNA();
testShadowResultScoring();

console.log("Stage 7 tests OK: signal lock, settlement, CLV, audit and idempotency.");
