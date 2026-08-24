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
import { applyShadowDisagreementGate } from "../src/shadow/gate.js";

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

const config = { minDataQuality: 50, minEdgePercent: 3, shadowDisagreementWarnPp: 5, shadowDisagreementRejectPp: 7 };

function gateCase(gapPp, confidence = 82) {
  const mainProbability = 0.297;
  return applyShadowDisagreementGate({
    item: {
      category: "value", confidence,
      candidate: { key: "home", side: "П1", probability: mainProbability, odds: 5.29, edge: 11.7, ev: 57.3, fairOdds: 1 / mainProbability }
    },
    shadow: { challenger: { probabilities: { home: mainProbability - gapPp / 100, draw: 0.281, away: 0.521 } } },
    risk: { score: 88, modelAgreement: 90, redFlags: [] },
    config
  });
}

function testShadowValueGate() {
  const gap2 = gateCase(2);
  assert.equal(gap2.item.category, "value");
  assert.equal(gap2.gate.shadowGateStatus, "OK");
  assert.equal(gap2.item.confidence, 82);

  const gap5 = gateCase(5);
  assert.equal(gap5.item.category, "value");
  assert.equal(gap5.gate.shadowGateStatus, "OK");

  const gap6 = gateCase(6);
  assert.equal(gap6.gate.shadowGateStatus, "WARN");
  assert.equal(gap6.item.category, "value");
  assert.ok(gap6.item.confidence < 82);
  assert.ok(gap6.risk.score < 88);

  const gap8 = gateCase(8);
  assert.equal(gap8.gate.shadowGateStatus, "BLOCK");
  assert.notEqual(gap8.item.category, "value");

  const udineseComo = applyShadowDisagreementGate({
    item: { category: "value", confidence: 82, candidate: { key: "home", side: "П1", probability: 0.297, odds: 5.29, edge: 11.7, ev: 57.3, fairOdds: 3.36 } },
    shadow: { challenger: { probabilities: { home: 0.198, draw: 0.281, away: 0.521 } } },
    risk: { score: 88, modelAgreement: 90, redFlags: [] }, config
  });
  assert.equal(udineseComo.item.modelDisagreementPp, 9.9);
  assert.equal(udineseComo.item.shadowGateStatus, "BLOCK");
  assert.equal(udineseComo.item.category, "near");
  assert.equal(udineseComo.item.reason, "Main/Shadow disagreement too high: 9.9 pp > 7.0 pp");
  assert.equal(udineseComo.item.candidate.probability, 0.297);
  assert.equal(udineseComo.item.candidate.fairOdds, 3.36);
}

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
  assert.equal(first.baseline.candidate.rawImpliedProbability, 1 / first.baseline.candidate.odds);
  assert.equal(first.baseline.candidate.noVigProbability, first.baseline.marketProbability[first.baseline.candidate.key]);
  assert.equal(first.baseline.candidate.edgePp, first.baseline.candidate.edge);
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
testShadowValueGate();

console.log("Stage 5 tests OK: live shadow separation, history, quota and result audit.");
