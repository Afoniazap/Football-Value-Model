import assert from "node:assert/strict";
import { renderAudit, renderDashboard, renderFixtureDiagnostic, renderMatchCard } from "../src/ui/presentation.js";
import { createTelegramUi } from "../src/ui/telegram.js";

const state = {
  loading: false,
  updatedAt: "2026-08-22T12:00:00Z",
  systemReadiness: { status: "READY" },
  fixtures: [], value: [], near: [], wait: [], rejected: [],
  sourceHealth: {
    "football-data.fixtures": { status: "OK" },
    "odds-api-io": { status: "N/A", meta: { reason: "NO_MATCHED_EVENTS" } }
  },
  telemetry: {
    finishedAt: "2026-08-22T12:00:00Z",
    fixturesInsideExactHorizon: 33,
    coverage: { market: { numerator: 3, denominator: 33, percent: 9.1 }, apiFootball: { numerator: 33, denominator: 33 }, lineups: { numerator: 0, denominator: 33 }, xg: { numerator: 0, denominator: 33, status: "N/A" } },
    dqDistribution: { average: 61.2, high: 4, mid: 20, low: 9 },
    categories: { VALUE: 0, NEAR: 1, WAIT: 32, NO_BET: 0 },
    blockers: { top: [{ reason: "NO_MARKET", count: 30 }] }
  }
};

const fixture = {
  id: "f1", home: "Марсель", away: "Страсбург", competition: "Ligue 1", utcDate: "2026-08-22T18:00:00Z",
  category: "near", confidence: 72, bookmaker: "bet365",
  dataQuality: 76,
  model: { home: 0.5, draw: 0.28, away: 0.22 },
  marketProbability: { home: 0.468, draw: 0.29, away: 0.242 },
  candidate: { side: "П1", key: "home", probability: 0.5, odds: 2.15, fairOdds: 2, edge: 3.2, ev: 7.5 },
  shadow: { shadowStatus: "OK", disagreementStatus: "LOW", challenger: { probabilities: { home: 0.48, draw: 0.29, away: 0.23 } } },
  diagnostics: {
    market: { source: "ODDS_API_IO", freshness: "FRESH" },
    dataQualityV2: { scoreNormalized: 76, rawScore: 61, availableMax: 80, components: [{ name: "История", score: 20, max: 20 }] },
    risk: { score: 82, modelAgreement: 65, redFlags: [
      { code: "SOURCE_PARTIAL", severity: "LOW", source: "football-data.context.FL1" },
      { code: "MODEL_DISAGREEMENT", severity: "MEDIUM", source: "model" }
    ] }, providerHealth: state.sourceHealth, sanityWarnings: []
  },
  contextAnalysis: { scoreHome: 1, scoreAway: 0, confidence: 40, independentSources: 1, contradictions: 0, events: [] }
};

const emptyAudit = {
  overall: { officialBets: 0, settledBets: 0, win: 0, loss: 0, push: 0, netUnits: 0, roi: null },
  integrity: { pending: 0 }, byMarket: {}, byOddsBand: {}
};

const dashboard = renderDashboard({ state, audit: emptyAudit, shadow: { sampleSize: 0 } });
assert.match(dashboard, /FVM — обзор/);
assert.match(dashboard, /Рынки: <b>3\/33/);
assert.match(dashboard, /Недостаточно данных/);

const card = renderMatchCard(fixture);
assert.match(card, /Марсель — Страсбург/);
assert.match(card, /Edge: <b>3\.2%/);
assert.match(card, /EV: <b>7\.5%/);
assert.match(card, /SHADOW ONLY/);

const dq = renderFixtureDiagnostic(fixture, "dq");
assert.equal(dq.title, "📚 DQ");
assert.match(dq.lines.join("\n"), /76\/100/);
assert.match(dq.lines.join("\n"), /Production DQ/);

const confidence = renderFixtureDiagnostic(fixture, "confidence");
assert.match(confidence.lines.join("\n"), /76 × 0,55/);
assert.match(confidence.lines.join("\n"), /порог VALUE/);

const risk = renderFixtureDiagnostic(fixture, "risk");
assert.match(risk.lines.join("\n"), /100 — лучше/);
assert.match(risk.lines.join("\n"), /100 − 6 − 12 − 0 = <b>82<\/b>/);

const edge = renderFixtureDiagnostic(fixture, "edge", { minDataQuality: 65, minEdgePercent: 4 });
assert.match(edge.lines.join("\n"), /50\.0% − 46\.8%/);
assert.match(edge.lines.join("\n"), /Не хватает <b>0\.8%/);

const ev = renderFixtureDiagnostic(fixture, "ev");
assert.match(ev.lines.join("\n"), /0\.5000 × 2\.15 − 1/);

const fair = renderFixtureDiagnostic(fixture, "fair");
assert.match(fair.lines.join("\n"), /1 ÷ 0\.5000/);

const stability = renderFixtureDiagnostic(fixture, "stability");
assert.match(stability.lines.join("\n"), /N\/A/);
assert.match(stability.lines.join("\n"), /не считается плохим качеством/);

const statistics = renderAudit("stats", { audit: emptyAudit, daily: null, shadow: null, state });
assert.match(statistics.lines.join("\n"), /append-only/);
assert.match(statistics.lines.join("\n"), /Недостаточно данных \(n=0\)/);

const sources = renderAudit("sources", { audit: null, daily: null, shadow: null, state });
assert.match(sources.lines.join("\n"), /NO_MATCHED_EVENTS/);
assert.match(sources.lines.join("\n"), /3\/33/);

const blockers = renderAudit("blockers", { audit: null, daily: null, shadow: null, state });
assert.match(blockers.lines.join("\n"), /нет подтверждённых рыночных котировок/);

const calls = [];
const uiState = { ...state, fixtures: [fixture], near: [fixture] };
const ui = createTelegramUi({
  config: { root: process.cwd(), allowedChatIds: new Set(["1"]), minDataQuality: 65, minEdgePercent: 4, refreshMinutes: 30, horizonHours: 24, logDeniedAccess: false },
  tg: async (method, body) => { calls.push({ method, body }); return { ok: true }; },
  stateRef: { current: uiState }, refreshData: async () => {}
});
await ui.handleCallback({ id: "q1", data: "card:f1", message: { chat: { id: 1 }, message_id: 10 } });
const cardMessage = calls.find(call => call.method === "sendMessage");
const callbacks = cardMessage.body.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
for (const metric of ["dq", "confidence", "risk", "edge", "ev", "fair", "stability"]) assert.ok(callbacks.includes(`${metric}:f1`));
for (const metric of ["dq", "confidence", "risk", "edge", "ev", "fair", "stability"]) {
  calls.length = 0;
  await ui.handleCallback({ id: `q-${metric}`, data: `${metric}:f1`, message: { chat: { id: 1 }, message_id: 10 } });
  assert.equal(calls.at(-1).method, "sendMessage");
  assert.doesNotMatch(calls.at(-1).body.text, /\{\s*"/);
}

console.log("Stage 17 tests OK: Russian product UI, real zero-sample handling, diagnostics and provider reasons.");
