// FVM statistics audit — READ-ONLY. Reads the append-only logs, never writes, never calls a provider, never touches SQLite.
//   node --no-warnings scripts/audit-statistics.mjs [--dir data/statistics] [--out fvm-statistics-audit.json] [--summary]
// Run from the repository root. Without --out the full JSON goes to stdout; --summary prints a compact text summary.
// Imports the project's own loaders/settlement so the numbers match the bot's.
// Sections: existing (the project's own stats), inventory, integrity, effectiveness, reliability.
import fs from "node:fs";
import path from "node:path";
import { canonicalTeamIdentity } from "../src/history/teamAliases.js";
import { buildPredictionStatistics } from "../src/statistics/predictionHistory.js";
import { buildMarketBetStatistics, settleMarket, profitForSettlement } from "../src/statistics/marketBetHistory.js";
import { buildDualShadowStatistics } from "../src/shadow/dualShadow.js";
import { buildV3ShadowStatistics } from "../src/shadow/v3History.js";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const dir = arg("dir", "data/statistics");
const readLines = file => { try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { type: "UNPARSEABLE" }; } }); } catch { return null; } };
const files = { predictions: "predictions.jsonl", marketBets: "market-bets.jsonl", dualShadow: "dual-shadow.jsonl", v3: "v3-shadow.jsonl" };
const logs = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readLines(path.join(dir, f))]));
const KEYS = ["home", "draw", "away"];
const ms = iso => Date.parse(iso);
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
const mean = a => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const sd = a => { const v = a.filter(Number.isFinite); if (v.length < 2) return null; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); };
const r = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const countBy = (rows, f) => rows.reduce((o, x) => { const k = f(x) ?? "∅"; o[k] = (o[k] || 0) + 1; return o; }, {});
const validP = p => p && KEYS.every(k => Number.isFinite(p[k])) && Math.abs(KEYS.reduce((s, k) => s + p[k], 0) - 1) < 0.02;
const outcomeOf = s => { const h = num(s?.home), a = num(s?.away); return h === null || a === null ? null : h > a ? "home" : h < a ? "away" : "draw"; };
const brier = (p, y) => KEYS.reduce((s, k) => s + (p[k] - (k === y ? 1 : 0)) ** 2, 0);
const logLoss = (p, y) => -Math.log(Math.max(1e-12, p[y]));

// ---- logical fixture identity (self-contained): same ordered club-identity pair, kickoffs < 24h apart
function fixtureGrouper() {
  const groups = [];
  return (home, away, kickoff) => {
    const key = `${canonicalTeamIdentity(home)}|${canonicalTeamIdentity(away)}`, t = ms(kickoff);
    let g = groups.find(x => x.key === key && Math.abs(x.t - t) < 24 * 3600e3);
    if (!g) { g = { key, t, id: groups.length + 1 }; groups.push(g); }
    return g.id;
  };
}
const group = fixtureGrouper();

const out = { generatedAt: new Date().toISOString(), dir, files: Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, v === null ? "MISSING" : `${v.length} events`])) };

// ---- 0. the project's own statistics (unchanged numbers; do not recompute what already exists)
out.existing = {
  prediction: logs.predictions ? buildPredictionStatistics(logs.predictions) : null,
  marketBets: logs.marketBets ? buildMarketBetStatistics(logs.marketBets) : null,
  dualShadow: logs.dualShadow ? buildDualShadowStatistics(logs.dualShadow) : null,
  v3: logs.v3 ? buildV3ShadowStatistics(logs.v3) : null
};

const P = logs.predictions || [], M = logs.marketBets || [], D = logs.dualShadow || [], V = logs.v3 || [];
const predictions = P.filter(e => e.type === "PREDICTION"), results = P.filter(e => e.type === "RESULT");
const snaps = P.filter(e => e.type === "SNAPSHOT"), snapResults = P.filter(e => e.type === "SNAPSHOT_RESULT");
const marketPreds = M.filter(e => e.type === "MARKET_BET_PREDICTION" && e.schemaVersion === 2), marketResults = M.filter(e => e.type === "MARKET_BET_RESULT");

// ---- 1. inventory
out.inventory = {
  predictionsLog: countBy(P, e => `${e.type}/v${e.schemaVersion ?? "?"}`),
  marketBetsLog: countBy(M, e => `${e.type}/v${e.schemaVersion ?? "?"}`),
  dualShadowLog: countBy(D, e => e.type),
  v3Log: countBy(V, e => e.type),
  predictionDateRange: [predictions.map(e => e.createdAt).sort()[0] ?? null, predictions.map(e => e.createdAt).sort().at(-1) ?? null],
  categoriesFirstSeen: countBy(predictions, e => e.category),
  categoriesLastPreMatchSnapshot: null,
  competitions: countBy(predictions, e => e.competitionCode || e.competition)
};

// last pre-match snapshot per logical fixture, first snapshot per logical fixture
const byFixture = new Map();
for (const s of snaps) {
  const id = group(s.home, s.away, s.kickoff);
  const e = byFixture.get(id) || { id, kickoff: s.kickoff, home: s.home, away: s.away, snaps: [] };
  e.snaps.push(s); byFixture.set(id, e);
}
for (const e of byFixture.values()) {
  e.snaps.sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  e.first = e.snaps[0];
  const pre = e.snaps.filter(s => ms(s.createdAt) < ms(s.kickoff));
  e.last = pre.at(-1) || null;
}
out.inventory.categoriesLastPreMatchSnapshot = countBy([...byFixture.values()].filter(e => e.last), e => e.last.category);
out.inventory.logicalFixturesWithSnapshots = byFixture.size;

// outcome per logical fixture from any result source
const finalScore = new Map();
for (const x of results) finalScore.set(group(x.home ?? predictions.find(p => p.snapshotKey === x.snapshotKey)?.home, x.away ?? predictions.find(p => p.snapshotKey === x.snapshotKey)?.away, predictions.find(p => p.snapshotKey === x.snapshotKey)?.kickoff), x.score);
for (const x of snapResults) { const s = snaps.find(y => y.fixtureKey === x.fixtureKey); if (s) finalScore.set(group(s.home, s.away, s.kickoff), x.finalScore); }

// ---- 2. integrity
const integrity = {};
const predGroups = new Map();
for (const p of predictions) { const id = group(p.home, p.away, p.kickoff); (predGroups.get(id) || predGroups.set(id, []).get(id)).push(p); }
integrity.predictions = {
  events: predictions.length, uniqueLogicalFixtures: predGroups.size,
  fixturesWithSeveralPredictions: [...predGroups.values()].filter(g => g.length > 1).length,
  extraPredictionRows: predictions.length - predGroups.size,
  createdAtOrAfterKickoff: predictions.filter(p => ms(p.createdAt) >= ms(p.kickoff)).length,
  invalidProbability: predictions.filter(p => !validP(p.probability)).length,
  withoutOdds: predictions.filter(p => !p.market || !Number.isFinite(p.market.odds)).length,
  graded: results.length, gradedWithoutPrediction: results.filter(x => !predictions.some(p => p.snapshotKey === x.snapshotKey)).length,
  overdueUngraded: predictions.filter(p => ms(p.kickoff) < Date.now() - 6 * 3600e3 && !results.some(x => x.snapshotKey === p.snapshotKey)).length,
  duplicateResultsPerKey: Object.values(countBy(results, x => x.snapshotKey)).filter(n => n > 1).length
};
integrity.snapshots = {
  events: snaps.length, logicalFixtures: byFixture.size,
  createdAtOrAfterKickoff: snaps.filter(s => ms(s.createdAt) >= ms(s.kickoff)).length,
  fixturesWithKickoffChange: [...byFixture.values()].filter(e => new Set(e.snaps.map(s => s.kickoff)).size > 1).length,
  fixturesWithSeveralFixtureKeys: [...byFixture.values()].filter(e => new Set(e.snaps.map(s => s.fixtureKey)).size > 1).length,
  snapshotResults: snapResults.length, duplicateSnapshotResultsPerFixtureKey: Object.values(countBy(snapResults, x => x.fixtureKey)).filter(n => n > 1).length,
  fixturesWithoutLastPreMatch: [...byFixture.values()].filter(e => !e.last).length
};
const betGroups = new Map();
for (const b of marketPreds) { const id = group(b.home, b.away, b.kickoff); (betGroups.get(id) || betGroups.set(id, []).get(id)).push(b); }
integrity.marketBets = {
  predictions: marketPreds.length, logicalFixtures: betGroups.size,
  fixturesWithSeveralBets: [...betGroups.values()].filter(g => g.length > 1).length,
  extraBetRowsCountedAsSeparateStakes: marketPreds.length - betGroups.size,
  createdAtOrAfterKickoff: marketPreds.filter(b => ms(b.createdAt) >= ms(b.kickoff)).length,
  legacyUngradable: M.filter(e => e.type === "MARKET_BET_PREDICTION" && e.schemaVersion !== 2).length,
  results: marketResults.length, duplicateResultsPerKey: Object.values(countBy(marketResults, x => x.snapshotKey)).filter(n => n > 1).length
};
const shadowP = D.filter(e => e.type === "SHADOW_PREDICTION"), shadowR = D.filter(e => e.type === "SHADOW_RESULT");
integrity.dualShadow = { predictions: shadowP.length, results: shadowR.length, createdAtOrAfterKickoff: shadowP.filter(p => ms(p.createdAt) >= ms(p.kickoff)).length, withMarketBenchmark: shadowR.filter(x => x.marketBenchmark).length, clvBenchmarkFilled: shadowR.filter(x => x.clvBenchmark).length };
const v3P = V.filter(e => e.type === "V3_PREDICTION"), v3R = V.filter(e => e.type === "V3_RESULT");
integrity.v3 = { predictions: v3P.length, results: v3R.length, createdAtOrAfterKickoff: v3P.filter(p => ms(p.createdAt) >= ms(p.kickoff)).length, unseenTeamPredictions: v3P.filter(p => p.unseenHome || p.unseenAway).length, byCompetition: countBy(v3P, p => p.competitionCode) };
out.integrity = integrity;

// ---- 3. effectiveness
const eff = {};
// 3a. probabilities: first-seen PREDICTION vs last pre-match SNAPSHOT, per logical fixture, graded only
function evalProbabilities(label, items) { // items: [{p, y, meta}]
  const ok = items.filter(i => validP(i.p) && i.y);
  const bins = Array.from({ length: 10 }, (_, b) => ({ range: `${b / 10}-${(b + 1) / 10}`, n: 0, p: 0, hits: 0 }));
  for (const i of ok) for (const k of KEYS) { const b = Math.min(9, Math.floor(i.p[k] * 10)); bins[b].n++; bins[b].p += i.p[k]; bins[b].hits += k === i.y ? 1 : 0; }
  const top = ok.map(i => ({ p: Math.max(...KEYS.map(k => i.p[k])), hit: KEYS.reduce((a, k) => (i.p[k] > i.p[a] ? k : a), "home") === i.y }));
  return {
    label, n: ok.length,
    brier: r(mean(ok.map(i => brier(i.p, i.y)))), logLoss: r(mean(ok.map(i => logLoss(i.p, i.y)))), accuracy: r(mean(top.map(t => (t.hit ? 1 : 0)))),
    meanDrawProbability: r(mean(ok.map(i => i.p.draw))), actualDrawRate: r(mean(ok.map(i => (i.y === "draw" ? 1 : 0)))),
    outcomeRates: { home: r(mean(ok.map(i => (i.y === "home" ? 1 : 0)))), draw: r(mean(ok.map(i => (i.y === "draw" ? 1 : 0)))), away: r(mean(ok.map(i => (i.y === "away" ? 1 : 0)))) },
    naiveBrier: (() => { if (!ok.length) return null; const f = Object.fromEntries(KEYS.map(k => [k, mean(ok.map(i => (i.y === k ? 1 : 0)))])); return r(mean(ok.map(i => brier(f, i.y)))); })(),
    calibration: bins.filter(b => b.n).map(b => ({ range: b.range, n: b.n, meanPredicted: r(b.p / b.n), observed: r(b.hits / b.n) }))
  };
}
const yOf = id => outcomeOf(finalScore.get(id));
eff.consensusFirstSeen = evalProbabilities("PREDICTION (first seen)", [...predGroups].map(([id, g]) => ({ p: g.sort((a, b) => ms(a.createdAt) - ms(b.createdAt))[0].probability, y: yOf(id) })));
eff.consensusLastPreMatch = evalProbabilities("SNAPSHOT consensus (last pre-match)", [...byFixture.values()].filter(e => e.last).map(e => ({ p: e.last.consensusProbability, y: yOf(e.id) })));
eff.teamStrengthLastPreMatch = evalProbabilities("Team Strength (last pre-match)", [...byFixture.values()].filter(e => e.last).map(e => ({ p: e.last.teamStrengthProbability, y: yOf(e.id) })));
eff.formLastPreMatch = evalProbabilities("Form (last pre-match)", [...byFixture.values()].filter(e => e.last).map(e => ({ p: e.last.formProbability, y: yOf(e.id) })));
// 3b. models on common samples already logged by the project: production/challenger/v2h and V3/Poisson/production
const sameSet = (label, rows, keys) => Object.fromEntries(keys.map(k => [k, { n: rows.length, brier: r(mean(rows.map(x => x.m[k]?.brier))), logLoss: r(mean(rows.map(x => x.m[k]?.logLoss))) }]));
eff.dualShadowCommon = shadowR.length ? sameSet("dual", shadowR.filter(x => x.metrics?.production && x.metrics?.challenger && x.metrics?.v2h).map(x => ({ m: x.metrics })), ["production", "challenger", "v2h"]) : null;
eff.v3Common = v3R.length ? sameSet("v3", v3R.filter(x => x.metrics?.v3 && x.metrics?.production).map(x => ({ m: x.metrics })), ["v3", "independentPoisson", "production"]) : null;
// 3c. model vs market (no-vig benchmark logged at the last observation before kickoff) on the subset where it exists
const bench = shadowR.filter(x => x.marketBenchmark?.closingNoVig && validP(x.marketBenchmark.closingNoVig));
eff.modelVsMarketNoVig = bench.length ? { n: bench.length, marketBrier: r(mean(bench.map(x => brier(x.marketBenchmark.closingNoVig, x.actual)))), productionBrier: r(mean(bench.map(x => x.metrics.production.brier))), note: "benchmarkOnly last observation before kickoff, best-of-books 1X2; not a closing line of a sharp bookmaker" } : { n: 0 };

// 3d. virtual one-bet-per-fixture results from SNAPSHOT_RESULT (last pre-match snapshot's own market). NOT independent bets per snapshot.
const graded = [];
for (const x of snapResults) {
  const s = snaps.find(y => y.fixtureKey === x.fixtureKey && ms(y.createdAt) < ms(y.kickoff) && y.market === x.market && y.selection === x.selection && y.odds === x.odds) || snaps.find(y => y.fixtureKey === x.fixtureKey);
  if (!s) continue;
  graded.push({ category: s.category, market: x.market, league: s.competitionCode || s.competition, odds: x.odds, settlement: x.settlement, profit: x.profitLossUnits, stake: x.stakeUnits, modelP: s.modelProbability, edge: s.edge, ev: s.ev, confidence: s.confidence, dq: s.dataQuality, fixture: group(s.home, s.away, s.kickoff) });
}
function roiTable(rows) {
  const settled = rows.filter(x => x.stake > 0), profits = settled.map(x => x.profit);
  const n = settled.length, m = mean(profits), s = sd(profits);
  return { bets: rows.length, settled: n, outcomes: countBy(rows, x => x.settlement), unitProfit: r(profits.reduce((a, b) => a + b, 0), 3), roi: r(m), roi95: n > 1 && s !== null ? [r(m - 1.96 * s / Math.sqrt(n)), r(m + 1.96 * s / Math.sqrt(n))] : null, averageOdds: r(mean(settled.map(x => x.odds)), 2), modelExpectedEvPct: r(mean(settled.map(x => num(x.ev))), 2), expectedHitRate: r(mean(settled.map(x => x.modelP))), observedWinRate: r(mean(settled.map(x => (["WIN", "HALF_WIN"].includes(x.settlement) ? 1 : 0)))) };
}
const bucket = (v, edges) => { if (!Number.isFinite(v)) return "N/A"; for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`; return `${edges.at(-1)}+`; };
const split = f => Object.fromEntries(Object.entries(Object.groupBy ? Object.groupBy(graded, f) : graded.reduce((o, x) => ((o[f(x)] ||= []).push(x), o), {})).map(([k, v]) => [k, roiTable(v)]));
eff.virtualBets = { note: "one bet per logical fixture = last pre-match SNAPSHOT market; calculated EV is model expectation, ROI is realised", overall: roiTable(graded), byCategory: split(x => x.category), byMarket: split(x => x.market), byLeague: split(x => x.league), byConfidence: split(x => bucket(x.confidence, [60, 65, 70, 75])), byDataQuality: split(x => bucket(x.dq, [50, 60, 70, 80])) };
// 3e. production market-bet log, raw vs one bet per fixture (first and last record)
const mrByKey = new Map(marketResults.map(x => [x.snapshotKey, x]));
const betRows = marketPreds.map(b => ({ b, res: mrByKey.get(b.snapshotKey), fixture: group(b.home, b.away, b.kickoff) })).filter(x => x.res);
const asRow = x => ({ settlement: x.res.settlement, profit: x.res.unitProfit, stake: x.res.unitStake, odds: x.b.odds, ev: x.b.ev, modelP: x.b.modelProbability });
const firstPer = new Map(), lastPer = new Map();
for (const x of [...betRows].sort((a, b) => ms(a.b.createdAt) - ms(b.b.createdAt))) { if (!firstPer.has(x.fixture)) firstPer.set(x.fixture, x); lastPer.set(x.fixture, x); }
eff.marketBetLog = { rawAsLogged: roiTable(betRows.map(asRow)), onePerFixtureFirst: roiTable([...firstPer.values()].map(asRow)), onePerFixtureLast: roiTable([...lastPer.values()].map(asRow)), byCategoryRaw: Object.fromEntries(["VALUE", "NEAR"].map(c => [c, roiTable(betRows.filter(x => x.b.category === c).map(asRow))])) };
// 3f. CLV availability
const movement = [...byFixture.values()].map(e => { const a = e.snaps.filter(s => ms(s.createdAt) < ms(s.kickoff) && s.market && s.selection && Number.isFinite(s.odds)); if (a.length < 2) return null; const f = a[0], l = a.at(-1); return f.market === l.market && f.selection === l.selection && f.line === l.line ? { fixture: e.id, first: f.odds, last: l.odds, move: l.odds / f.odds - 1 } : null; }).filter(Boolean);
eff.clv = {
  closingOddsStored: { productionBets: marketPreds.filter(b => "closingOdds" in b).length, snapshotResults: snapResults.filter(x => "closingOdds" in x).length, shadowClvBenchmarkFilled: integrity.dualShadow.clvBenchmarkFilled },
  proxyOnlyNotClv: { fixturesWithTwoPlusPreMatchSnapshots: movement.length, meanOddsMovePct: r(mean(movement.map(m => m.move)) * 100, 2), shorteningShare: r(mean(movement.map(m => (m.move < 0 ? 1 : 0)))) },
  verdict: "No production closing odds are stored: CLV cannot be computed. Proxy = first vs last observed best-of-books price (not a closing line)."
};
out.effectiveness = eff;

// ---- 4. reliability
const rel = {};
// independent re-grading of 1X2 stored results from the stored score
let mismatch1x2 = 0, checked1x2 = 0;
for (const x of snapResults) if (x.market === "1X2" && x.finalScore) { const y = outcomeOf(x.finalScore); const sel = x.selection === "П1" ? "home" : x.selection === "П2" ? "away" : x.selection === "X" ? "draw" : null; if (!y || !sel) continue; checked1x2++; if ((y === sel) !== (x.settlement === "WIN")) mismatch1x2++; }
rel.regrade1x2 = { checked: checked1x2, mismatches: mismatch1x2 };
let mismatchAll = 0, checkedAll = 0;
for (const x of snapResults) { if (!x.finalScore) continue; const again = settleMarket({ market: x.market, selection: x.selection, line: x.line }, { status: "FINISHED", score: { fullTime: x.finalScore } }); checkedAll++; if (again !== x.settlement || Math.abs(profitForSettlement(again, x.odds) - x.profitLossUnits) > 1e-9) mismatchAll++; }
rel.regradeAllMarkets = { checked: checkedAll, mismatches: mismatchAll };
rel.resultOutcomeVsScore = { checked: results.length, mismatches: results.filter(x => x.score && outcomeOf(x.score) !== x.actual).length };
rel.anomalies = {
  modelProbabilityAbove90: snaps.filter(s => Math.max(...KEYS.map(k => s.consensusProbability?.[k] ?? 0)) >= 0.9).length,
  evAbove100pct: snaps.filter(s => num(s.ev) > 100).length, edgeAbove30pp: snaps.filter(s => num(s.edge) > 30).length,
  oddsAbove20: snaps.filter(s => num(s.odds) > 20).length, oddsBelow1_1: snaps.filter(s => num(s.odds) !== null && num(s.odds) < 1.1).length,
  modelVsMarketGapAbove30pp: snaps.filter(s => num(s.modelProbability) !== null && num(s.marketProbability) !== null && Math.abs(s.modelProbability - s.marketProbability) > 0.3).length
};
rel.knockoutExtraTimeRisk = { note: "API-Football finished rows use goals incl. extra time; check graded matches with AET/PEN status in SQLite (name-corpus tool) before trusting 1X2/OU/AH settlement for cup ties", gradedResultsWithScoreSource: countBy(results, x => x.resultSource) };
out.reliability = rel;
// ---- output: full JSON (stdout, or --out <file>) and an optional compact text summary (--summary) for pasting elsewhere
const json = JSON.stringify(out, null, 1);
const outFile = arg("out", null);
if (outFile) fs.writeFileSync(outFile, json, "utf8"); else console.log(json);
if (process.argv.includes("--summary")) {
  const v = out.inventory, i = out.integrity, e = out.effectiveness, rl = out.reliability;
  const L = [];
  const put = (k, x) => L.push(`${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`);
  const cal = m => (m ? { n: m.n, brier: m.brier, naiveBrier: m.naiveBrier, logLoss: m.logLoss, accuracy: m.accuracy, drawPred: m.meanDrawProbability, drawActual: m.actualDrawRate } : null);
  const roi = t => (t ? { bets: t.bets, settled: t.settled, outcomes: t.outcomes, roi: t.roi, ci95: t.roi95, avgOdds: t.averageOdds, modelEvPct: t.modelExpectedEvPct, expHit: t.expectedHitRate, obsWin: t.observedWinRate } : null);
  put("FILES", out.files); put("EVENT TYPES predictions.jsonl", v.predictionsLog); put("EVENT TYPES market-bets.jsonl", v.marketBetsLog);
  put("CATEGORY first seen", v.categoriesFirstSeen); put("CATEGORY last pre-match", v.categoriesLastPreMatchSnapshot); put("COMPETITIONS", v.competitions);
  for (const k of ["predictions", "snapshots", "marketBets", "dualShadow", "v3"]) put(`INTEGRITY ${k}`, i[k]);
  put("PROB consensus first seen", cal(e.consensusFirstSeen)); put("PROB consensus last pre-match", cal(e.consensusLastPreMatch));
  put("PROB Team Strength", cal(e.teamStrengthLastPreMatch)); put("PROB Form", cal(e.formLastPreMatch));
  put("CALIBRATION consensus last pre-match", e.consensusLastPreMatch?.calibration ?? null);
  put("DUAL-SHADOW common sample", e.dualShadowCommon); put("V3 common sample", e.v3Common); put("MODEL vs MARKET no-vig", e.modelVsMarketNoVig);
  const vb = e.virtualBets; put("VIRTUAL BETS overall", roi(vb.overall));
  for (const g of ["byCategory", "byMarket", "byLeague", "byConfidence", "byDataQuality"]) put(`VIRTUAL BETS ${g}`, Object.fromEntries(Object.entries(vb[g] || {}).map(([k, t]) => [k, roi(t)])));
  const m = e.marketBetLog; put("MARKET-BET LOG raw", roi(m.rawAsLogged)); put("MARKET-BET LOG one per fixture (first)", roi(m.onePerFixtureFirst)); put("MARKET-BET LOG one per fixture (last)", roi(m.onePerFixtureLast));
  put("CLV", e.clv); put("RELIABILITY", rl);
  console.log(L.join("\n"));
}
