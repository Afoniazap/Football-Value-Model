#!/usr/bin/env node
// FVM read-only audit. Reads <data>/history/*.jsonl only; never writes inside the data dir.
// Usage: node audit.mjs --data /path/to/data [--out report.json] [--md report.md]
// Zero dependencies. Output = observations on stored real predictions, NOT proof of profitability.
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const dataDir = path.resolve(args.data || "data");
const histDir = path.join(dataDir, "history");
for (const key of ["out", "md"]) {
  if (args[key] && path.resolve(args[key]).startsWith(dataDir + path.sep)) {
    console.error(`Refusing to write ${key} inside the data directory.`); process.exit(2);
  }
}

function readJsonl(name) {
  const file = path.join(histDir, name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const avg = xs => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
const r = (v, d = 4) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : v);
const KEYS = ["home", "draw", "away"], LAB = { home: "H", draw: "D", away: "A" };
const actualKey = res => ({ H: "home", D: "draw", A: "away" })[res];
const top = m => KEYS.reduce((b, k) => (m[k] > m[b] ? k : b), "home");
const brier = (m, res) => KEYS.reduce((s, k) => s + (m[k] - (actualKey(res) === k ? 1 : 0)) ** 2, 0) / 3;
const logloss = (m, res) => -Math.log(Math.max(1e-15, m[actualKey(res)]));
function wilson(k, n) { if (!n) return null; const z = 1.96, p = k / n, d = 1 + z * z / n; const c = p + z * z / (2 * n); const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [r((c - h) / d), r((c + h) / d)]; }

function modelStats(rows, key) {
  const x = rows.filter(row => row[key]);
  const correct = x.filter(row => top(row[key]) === actualKey(row.actualResult)).length;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 }));
  for (const row of x) for (const k of KEYS) { const b = Math.min(9, Math.floor(row[key][k] * 10)); bins[b].n++; bins[b].p += row[key][k]; bins[b].hit += actualKey(row.actualResult) === k ? 1 : 0; }
  const total = x.length * 3;
  const ece = total ? bins.reduce((s, b) => s + (b.n ? (b.n / total) * Math.abs(b.p / b.n - b.hit / b.n) : 0), 0) : null;
  const dist = o => KEYS.reduce((a, k) => ({ ...a, [LAB[k]]: o(k) }), {});
  const hi = t => { const s = x.filter(row => row[key][top(row[key])] >= t); const c = s.filter(row => top(row[key]) === actualKey(row.actualResult)).length; return { n: s.length, meanTopProb: r(avg(s.map(row => row[key][top(row[key])]))), hitRate: s.length ? r(c / s.length) : null, hitRateCI95: wilson(c, s.length) }; };
  return {
    n: x.length, accuracy: r(x.length ? correct / x.length : null), brier: r(avg(x.map(row => brier(row[key], row.actualResult)))), logLoss: r(avg(x.map(row => logloss(row[key], row.actualResult)))), ece: r(ece),
    meanPredicted: dist(k => r(avg(x.map(row => row[key][k])))), actualRate: dist(k => r(x.length ? x.filter(row => actualKey(row.actualResult) === k).length / x.length : null)),
    top80: hi(0.8), top90: hi(0.9),
    minDrawProb: r(Math.min(...x.map(row => row[key].draw))),
    reliability: bins.map((b, i) => ({ bin: `${i / 10}-${(i + 1) / 10}`, n: b.n, meanPredicted: b.n ? r(b.p / b.n) : null, actualFreq: b.n ? r(b.hit / b.n) : null }))
  };
}

function roiGroup(rows, keyFn) {
  const g = new Map();
  for (const row of rows) { const k = keyFn(row); if (k == null) continue; (g.get(k) || g.set(k, []).get(k)).push(row); }
  return Object.fromEntries([...g].sort().map(([k, xs]) => {
    const roi = xs.map(x => x.roi), m = avg(roi), sd = Math.sqrt(avg(roi.map(v => (v - m) ** 2)));
    return [k, { n: xs.length, wins: xs.filter(x => x.status === "WIN").length, roi: r(m), roiSE: r(sd / Math.sqrt(xs.length)), note: xs.length < 30 ? "n<30: not interpretable" : undefined }];
  }));
}

const out = { generatedAt: new Date().toISOString(), dataDir, warning: "Observational stored-data audit. Not proof of profitability; no thresholds were changed." };
const files = ["analyses", "signals", "official-signals", "signal-events", "settlements", "shadow-signals", "shadow-results"];
const data = Object.fromEntries(files.map(f => [f, readJsonl(`${f}.jsonl`)]));
out.inventory = Object.fromEntries(files.map(f => [f, data[f] ? data[f].length : "MISSING"]));

// 1. Production vs Challenger on stored pre-match probabilities (one row per fixture).
const sr = data["shadow-results"] || [];
const byFx = new Map(); for (const row of sr) if (row.actualResult && !byFx.has(row.fixtureId)) byFx.set(row.fixtureId, row);
const fx = [...byFx.values()];
out.forecastQuality = { note: "Only fixtures that had a market and OK shadow (selection-biased subset). Brier/LogLoss != betting profit.", baseline: modelStats(fx, "baselineProbability"), challenger: modelStats(fx, "challengerProbability") };
const strongGap = fx.filter(x => x.baselineProbability && x.challengerProbability && Math.abs(x.baselineProbability[top(x.baselineProbability)] - x.challengerProbability[top(x.baselineProbability)]) > 0.07);
out.forecastQuality.fixturesWithTopPickGapOver7pp = { n: strongGap.length, baseline: modelStats(strongGap, "baselineProbability"), challenger: modelStats(strongGap, "challengerProbability") };

// 2. Official signals joined with settlements.
const offs = data["official-signals"] || [], sets = new Map((data.settlements || []).map(s => [s.signalId, s]));
const bet = offs.filter(o => sets.has(o.signalId)).map(o => {
  const s = sets.get(o.signalId), selKey = ({ "П1": "home", "X": "draw", "П2": "away" })[o.selection];
  const ch = o.challengerProbabilities?.[selKey];
  return { ...o, status: s.status, roi: s.roi ?? (s.netUnits / (s.stake || 1)), selKey, gapPp: Number.isFinite(ch) ? Math.abs(o.modelProbability - ch) * 100 : null };
}).filter(o => Number.isFinite(o.roi));
const bin = (v, edges) => v == null ? null : edges.find((e, i) => v < e || i === edges.length - 1) === undefined ? null : `<${edges.find(e => v < e) ?? "inf"}`;
out.officialSignals = {
  settled: bet.length, overall: roiGroup(bet, () => "ALL"), bySelection: roiGroup(bet, o => o.selection),
  byModelProbability: roiGroup(bet, o => bin(o.modelProbability, [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01])),
  byEdgePp: roiGroup(bet, o => bin(o.edge, [5, 8, 12, 20, 30, 1e9])),
  byShadowGapPp: roiGroup(bet, o => bin(o.gapPp, [2, 4, 6, 8, 1e9])),
  byDQv2: roiGroup(bet, o => bin(o.DQ?.scoreNormalized, [60, 70, 80, 90, 101])),
  byConfidence: roiGroup(bet, o => bin(o.Confidence, [70, 75, 80, 85, 101])),
  byMarketSource: roiGroup(bet, o => o.marketSource || "unknown"), byFreshness: roiGroup(bet, o => o.marketFreshness || "unknown"),
  calibrationOfSelectedSide: Object.fromEntries([[0.5, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([a, b]) => { const xs = bet.filter(o => o.modelProbability >= a && o.modelProbability < b); return [`${a}-${b}`, { n: xs.length, meanModelProb: r(avg(xs.map(o => o.modelProbability))), winRate: xs.length ? r(xs.filter(o => o.status === "WIN").length / xs.length) : null }]; }))
};

// 3. Gate counterfactuals using stored fields (observational).
function gates(o) {
  const g = [];
  if (o.edge > 30) g.push("SANITY_EDGE_OVER_30PP"); if (o.EV > 100) g.push("SANITY_EV_OVER_100");
  if (o.fairOdds < 1.1 || o.fairOdds > 20) g.push("SANITY_EXTREME_FAIR_ODDS");
  if (o.DQ?.scoreNormalized != null && o.DQ.scoreNormalized < 65) g.push("DQV2_BELOW_65");
  if (o.gapPp != null && o.gapPp > 7) g.push("SHADOW_GAP_OVER_7PP"); else if (o.gapPp == null) g.push("SHADOW_UNAVAILABLE");
  if (o.modelProbability >= 0.9) g.push("MODEL_PROB_OVER_90");
  if (o.marketFreshness && o.marketFreshness !== "FRESH") g.push("MARKET_NOT_FRESH");
  return g;
}
const gateCount = {}; for (const o of bet) for (const g of gates(o)) gateCount[g] = roiGroup(bet.filter(x => gates(x).includes(g)), () => g)[g];
out.gateCounterfactual = { note: "Issued official signals that would have tripped each hypothetical gate (diagnostic; gates not enforced in production except shadow>7pp and STALE).", tripped: gateCount, passedAll: roiGroup(bet.filter(o => !gates(o).length), () => "passed_all")["passed_all"] || { n: 0 } };

// 4. Integrity of issued signals.
const bad = { oddsOutOfRange: 0, issuedAtOrAfterKickoff: 0, observedAfterKickoff: 0, missingChallenger: 0, missingDQ: 0, duplicateIds: offs.length - new Set(offs.map(o => o.signalId)).size };
for (const o of offs) {
  if (!(o.officialOdds > 1.01 && o.officialOdds < 30)) bad.oddsOutOfRange++;
  if (new Date(o.issuedAt) >= new Date(o.kickoff)) bad.issuedAtOrAfterKickoff++;
  if (o.marketObservedAt && new Date(o.marketObservedAt) >= new Date(o.kickoff)) bad.observedAfterKickoff++;
  if (!o.challengerProbabilities) bad.missingChallenger++; if (!o.DQ) bad.missingDQ++;
}
out.integrity = { issued: offs.length, ...bad };

// 5. Persistence gaps (which gate decisions can be audited from storage).
const sig = data.signals || [];
out.persistence = {
  signalsWithShadowGateField: sig.filter(s => s.shadowGate || s.diagnostics?.shadowGate).length, signalsWithReasonField: sig.filter(s => s.reason).length, signalsTotal: sig.length,
  note: "If 0, downgrade reasons (e.g. VALUE->NEAR by shadow gate) are not auditable from stored history."
};

const json = JSON.stringify(out, null, 2);
if (args.out) fs.writeFileSync(args.out, json); else console.log(json);
