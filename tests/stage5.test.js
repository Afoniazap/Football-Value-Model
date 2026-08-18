import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildModel } from "../src/model/probability.js";
import { classify } from "../src/decision/classify.js";
import { createLivePreMatchContext } from "../src/shadow/liveContext.js";
import {
  buildShadowComparison,
  disagreementStatus
} from "../src/shadow/comparison.js";
import { createHistoryStore } from "../src/storage/history.js";
import { scoreFinishedShadow } from "../src/shadow/scoring.js";

function fixture(id = "20") {
  return {
    id,
    competitionCode: "TL",
    competition: "Test League",
    utcDate: "2026-01-10T12:00:00Z",
    home: "Team 1",
    away: "Team 2",
    homeId: 1,
    awayId: 2,
    matchday: 10
  };
}

function match(id, utcDate, homeTeamId, awayTeamId, homeGoals, awayGoals) {
  return {
    id: String(id),
    utcDate,
    homeTeam: { id: homeTeamId, name: `Team ${homeTeamId}` },
    awayTeam: { id: awayTeamId, name: `Team ${awayTeamId}` },
    score: { fullTime: { home: homeGoals, away: awayGoals } }
  };
}

function context() {
  const matches = [
    match(1, "2026-01-01T12:00:00Z", 1, 3, 2, 0),
    match(2, "2026-01-02T12:00:00Z", 4, 1, 1, 1),
    match(3, "2026-01-03T12:00:00Z", 1, 5, 3, 1),
    match(4, "2026-01-04T12:00:00Z", 6, 1, 0, 1),
    match(5, "2026-01-05T12:00:00Z", 1, 7, 2, 2),
    match(6, "2026-01-01T12:00:00Z", 2, 8, 1, 0),
    match(7, "2026-01-02T12:00:00Z", 9, 2, 2, 1),
    match(8, "2026-01-03T12:00:00Z", 2, 10, 0, 0),
    match(9, "2026-01-04T12:00:00Z", 11, 2, 1, 2),
    match(10, "2026-01-05T12:00:00Z", 2, 12, 2, 2)
  ];
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

function oddsEvent(home = 2.2, draw = 3.3, away = 3.1) {
  return {
    home_team: "Team 1",
    away_team: "Team 2",
    bookmakers: [{
      title: "Book",
      markets: [{
        key: "h2h",
        outcomes: [
          { name: "Team 1", price: home },
          { name: "Draw", price: draw },
          { name: "Team 2", price: away }
        ]
      }]
    }]
  };
}

const config = { minDataQuality: 50, minEdgePercent: 3 };

function classifiedBaseline(event = oddsEvent()) {
  const f = fixture();
  const c = context();
  const modelled = buildModel(f, c);
  return {
    f,
    c,
    baseline: classify(modelled, event, config),
    event
  };
}

function testIdenticalFixtureInputAndOddsDoNotEnterChallenger() {
  const first = classifiedBaseline(oddsEvent(2.2, 3.3, 3.1));
  const second = classifiedBaseline(oddsEvent(9.5, 9.5, 1.2));
  const shadowA = buildShadowComparison({
    fixture: first.f,
    context: first.c,
    baseline: first.baseline,
    oddsEvent: first.event,
    config,
    providerHealth: {}
  });
  const shadowB = buildShadowComparison({
    fixture: second.f,
    context: second.c,
    baseline: second.baseline,
    oddsEvent: second.event,
    config,
    providerHealth: {}
  });
  assert.deepEqual(shadowA.challenger.probabilities, shadowB.challenger.probabilities);
}

function testShadowNeverReplacesProductionCategory() {
  const data = classifiedBaseline();
  const shadow = buildShadowComparison({
    fixture: data.f,
    context: data.c,
    baseline: data.baseline,
    oddsEvent: data.event,
    config,
    providerHealth: {}
  });
  assert.equal(data.baseline.category, shadow.baseline.category);
  assert.ok(shadow.challenger.shadowCategory);
}

function testDisagreementThresholds() {
  assert.equal(disagreementStatus({ maxProbabilityDifference: 0.049 }), "MODEL_AGREE");
  assert.equal(disagreementStatus({ maxProbabilityDifference: 0.05 }), "MODEL_MILD_DISAGREEMENT");
  assert.equal(disagreementStatus({ maxProbabilityDifference: 0.10 }), "MODEL_MILD_DISAGREEMENT");
  assert.equal(disagreementStatus({ maxProbabilityDifference: 0.101 }), "MODEL_STRONG_DISAGREEMENT");
}

function testShadowHistoryAppendRevision() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-stage5-"));
  const store = createHistoryStore(root);
  const data = classifiedBaseline(oddsEvent());
  const shadow = buildShadowComparison({
    fixture: data.f,
    context: data.c,
    baseline: data.baseline,
    oddsEvent: data.event,
    config,
    providerHealth: { odds: { status: "OK" } }
  });
  const item = { ...data.baseline, shadow, diagnostics: { providerHealth: {}, dataQualityV2: { scoreNormalized: 80 }, risk: { score: 20 } } };
  store.appendShadowSignals({ analysisId: "a1", analysedAt: "2026-01-09T12:00:00Z", items: [item] });
  store.appendShadowSignals({ analysisId: "a2", analysedAt: "2026-01-09T12:05:00Z", items: [item] });
  const initial = store.readShadowSignals();
  assert.equal(initial.length, 3);

  const changed = classifiedBaseline(oddsEvent(2.4, 3.3, 3.1));
  const changedShadow = buildShadowComparison({
    fixture: changed.f,
    context: changed.c,
    baseline: changed.baseline,
    oddsEvent: changed.event,
    config,
    providerHealth: { odds: { status: "OK" } }
  });
  store.appendShadowSignals({
    analysisId: "a3",
    analysedAt: "2026-01-09T12:10:00Z",
    items: [{ ...changed.baseline, shadow: changedShadow, diagnostics: { providerHealth: {} } }]
  });
  const revised = store.readShadowSignals();
  assert.ok(revised.length > initial.length);
  assert.ok(revised.some(row => row.revision === 2));
}

function testFinishedResultScoring() {
  const record = {
    fixtureId: "1",
    baselineProbability: { home: 0.6, draw: 0.25, away: 0.15 },
    challengerProbability: { home: 0.45, draw: 0.3, away: 0.25 }
  };
  const scored = scoreFinishedShadow(record, "H");
  assert.ok(scored.baselineBrier < scored.challengerBrier);
  assert.equal(scored.baselineTopPickCorrect, true);
}

function testQuotaLeavesModelProbabilityAvailableAndMarketNA() {
  const data = classifiedBaseline(null);
  const shadow = buildShadowComparison({
    fixture: data.f,
    context: data.c,
    baseline: data.baseline,
    oddsEvent: null,
    config,
    providerHealth: { odds: { status: "QUOTA" } }
  });
  assert.equal(shadow.shadowStatus, "OK");
  assert.ok(shadow.baseline.probabilities);
  assert.ok(shadow.challenger.probabilities);
  assert.equal(shadow.baseline.market.status, "N/A");
  assert.equal(shadow.challenger.market.selected, null);
}

testIdenticalFixtureInputAndOddsDoNotEnterChallenger();
testShadowNeverReplacesProductionCategory();
testDisagreementThresholds();
testShadowHistoryAppendRevision();
testFinishedResultScoring();
testQuotaLeavesModelProbabilityAvailableAndMarketNA();

console.log("Stage 5 tests OK: live shadow separation, history, quota and result audit.");
