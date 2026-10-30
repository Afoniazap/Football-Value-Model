import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { observeRatingsShadow, RATINGS_KILL_FILE_NAME } from "../src/shadow/ratings/ratingsObserver.js";
import { applyHook, MARKER } from "../scripts/apply-ratings-v1-hook.mjs";
import { analyseFixture } from "../src/engine/analyse.js";
import { buildDualShadow, updateDualShadowHistory } from "../src/shadow/dualShadow.js";
import { updatePredictionSnapshots } from "../src/statistics/predictionHistory.js";

const NOW = "2026-10-20T10:00:00.000Z";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fvm-ratings-obs-"));
const sha = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }
function row(i, home, away, hg, ag, iso, code = "PL") { return { playedAt: iso, status: "FINISHED", competition: { code, name: "Premier League" }, homeTeam: { name: home }, awayTeam: { name: away }, score: { fullTime: { home: hg, away: ag } }, provenance: { source: "FOOTBALL_DATA" }, sourceFixtureId: String(i) }; }
function history() {
  const teams = ["Arsenal", "Chelsea", "Everton", "Fulham"], out = [];
  let i = 0;
  for (let d = 0; d < 24; d++) for (let a = 0; a < 4; a += 2) { const h = teams[(a + d) % 4], g = teams[(a + d + 1) % 4]; out.push(row(i++, h, g, (d + a) % 4, (d + 1) % 3, new Date(Date.UTC(2026, 7, 1 + d, 15)).toISOString())); }
  return out;
}
const fixture = (id, home, away, iso, code = "PL") => ({ id, home, away, competition: "Premier League", competitionCode: code, utcDate: iso, category: "NEAR", best: null });
const results = () => [fixture("1", "Arsenal", "Chelsea", "2026-10-21T15:00:00.000Z"), fixture("2", "Everton", "Fulham", "2026-10-22T15:00:00.000Z"),
  fixture("3", "Arsenal", "Everton", "2026-10-19T15:00:00.000Z"), fixture("4", "Alpha", "Beta", "2026-10-21T15:00:00.000Z", "L1")];
const read = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);

test("flag off: nothing is written, nothing is created, inputs untouched", () => {
  const dir = tmp(), file = path.join(dir, "ratings.jsonl"), r = results(), h = history(), before = [sha(r), sha(h)];
  const out = observeRatingsShadow({ file, results: r, history: h, now: NOW, enabled: false });
  assert.equal(out.status, "DISABLED"); assert.deepEqual(fs.readdirSync(dir), []); assert.deepEqual([sha(r), sha(h)], before);
});

test("flag on: writes only upcoming supported-league fixtures, before kickoff, without mutating (frozen) inputs", () => {
  const dir = tmp(), file = path.join(dir, "sub", "ratings.jsonl"), r = deepFreeze(results()), h = deepFreeze(history()), before = [sha(r), sha(h)];
  const out = observeRatingsShadow({ file, results: r, history: h, now: NOW, enabled: true });
  assert.equal(out.status, "OK"); assert.equal(out.written, 2); assert.deepEqual(out.skipped, { past: 1, unsupportedLeague: 1, invalid: 0 });
  const records = read(file);
  assert.deepEqual(records.map(x => x.fixtureId).sort(), ["1", "2"]);
  for (const rec of records) { assert.ok(rec.createdAt < rec.kickoff && rec.leadHours > 0); assert.equal(rec.model, "ratings-v1"); assert.ok(rec.paramsId.startsWith("ratings-v1.1:")); assert.ok(Math.abs(rec.probability.home + rec.probability.draw + rec.probability.away - 1) < 1e-9); }
  assert.deepEqual([sha(r), sha(h)], before, "inputs unchanged");
});

test("idempotent and append-only: a repeat writes nothing, a later cycle adds only new fixtures and never edits earlier lines", () => {
  const dir = tmp(), file = path.join(dir, "ratings.jsonl"), h = history();
  observeRatingsShadow({ file, results: results(), history: h, now: NOW, enabled: true });
  const first = fs.readFileSync(file);
  assert.equal(observeRatingsShadow({ file, results: results(), history: h, now: NOW, enabled: true }).written, 0);
  assert.ok(fs.readFileSync(file).equals(first));
  const later = [...results(), fixture("5", "Chelsea", "Fulham", "2026-10-23T15:00:00.000Z")];
  const grown = [...h, row(99, "Arsenal", "Fulham", 3, 0, "2026-10-19T15:00:00.000Z")];       // new information arrived in between
  assert.equal(observeRatingsShadow({ file, results: later, history: grown, now: "2026-10-20T20:00:00.000Z", enabled: true }).written, 1);
  const after = fs.readFileSync(file);
  assert.ok(after.subarray(0, first.length).equals(first), "earlier lines byte-identical; the already-recorded fixtures keep their first prediction");
});

test("no look-ahead: results not yet final (or later than now) cannot influence a recorded prediction", () => {
  const base = history(), recent = row(100, "Arsenal", "Chelsea", 9, 0, "2026-10-20T08:30:00.000Z");     // finished only after 11:30 -> not final at 10:00
  const future = row(101, "Arsenal", "Chelsea", 0, 9, "2026-10-25T15:00:00.000Z");
  const predict = h => { const dir = tmp(), file = path.join(dir, "r.jsonl"); observeRatingsShadow({ file, results: [fixture("1", "Arsenal", "Chelsea", "2026-10-21T15:00:00.000Z")], history: h, now: NOW, enabled: true }); const { createdAt, ...rec } = read(file)[0]; return rec; };
  assert.deepEqual(predict([...base, recent, future]), predict(base));
  const rewritten = base.map((x, i) => (i === base.length - 1 ? { ...x, score: { fullTime: { home: 7, away: 7 } } } : x));
  assert.notDeepEqual(predict(rewritten).probability, predict(base).probability, "a result that WAS final does change the prediction (sanity check of the test)");
});

test("kill file disables at runtime without restart", () => {
  const dir = tmp(), file = path.join(dir, "ratings.jsonl");
  fs.writeFileSync(path.join(dir, RATINGS_KILL_FILE_NAME), "");
  assert.equal(observeRatingsShadow({ file, results: results(), history: history(), now: NOW, enabled: true }).status, "KILLED");
  assert.ok(!fs.existsSync(file));
});

test("never throws: broken history, broken results, unwritable target, throwing logger", () => {
  const dir = tmp(), file = path.join(dir, "ratings.jsonl");
  const boom = new Proxy([], { get() { throw new Error("history exploded"); } });
  assert.equal(observeRatingsShadow({ file, results: results(), history: boom, now: NOW, enabled: true, logger: { warn() { throw new Error("logger exploded"); } } }).status, "ERROR");
  assert.equal(observeRatingsShadow({ file, results: null, history: undefined, now: NOW, enabled: true }).status, "OK");
  assert.equal(observeRatingsShadow({ file, results: [null, {}, { utcDate: "x" }], history: history(), now: NOW, enabled: true }).skipped.invalid, 3);
  const blocker = path.join(dir, "blocker"); fs.writeFileSync(blocker, "x");
  assert.ok(["OK", "ERROR"].includes(observeRatingsShadow({ file: path.join(blocker, "nested", "r.jsonl"), results: results(), history: history(), now: NOW, enabled: true }).status));
  assert.equal(observeRatingsShadow({ file, results: results(), history: history(), now: "not a date", enabled: true }).status, "ERROR");
});

// ---- Production identity: same inputs, observer off vs on -> byte-identical Production outputs and Shadow files
function productionCycle(enabled) {
  const dir = tmp(), files = { dual: path.join(dir, "dual-shadow.jsonl"), pred: path.join(dir, "predictions.jsonl"), ratings: path.join(dir, "ratings-v1-shadow.jsonl") };
  const config = { minDataQuality: 70, minEdge: 4, minEv: 5, minConfidence: 70, minStability: 70 };
  const total = [{ team: { id: 1, name: "Arsenal" }, playedGames: 12, points: 24, goalsFor: 22, goalsAgainst: 12, goalDifference: 10 }, { team: { id: 2, name: "Chelsea" }, playedGames: 12, points: 17, goalsFor: 15, goalsAgainst: 15, goalDifference: 0 }];
  const finished = [];
  for (let i = 0; i < 6; i++) { finished.push({ id: `h${i}`, utcDate: `2026-08-0${i + 1}T12:00:00Z`, homeTeam: { id: 1, name: "Arsenal" }, awayTeam: { id: 10 + i, name: `H${i}` }, score: { fullTime: { home: 2, away: 1 } } }); finished.push({ id: `a${i}`, utcDate: `2026-08-0${i + 1}T15:00:00Z`, homeTeam: { id: 20 + i, name: `A${i}` }, awayTeam: { id: 2, name: "Chelsea" }, score: { fullTime: { home: 1, away: 1 } } }); }
  const context = { standings: { standings: [{ type: "TOTAL", table: total }, { type: "HOME", table: total }, { type: "AWAY", table: total }] }, finished, scheduled: [] };
  const fx = { id: "1", homeId: 1, awayId: 2, home: "Arsenal", away: "Chelsea", competition: "Premier League", competitionCode: "PL", utcDate: "2026-10-21T15:00:00Z" };
  const odds = { agreement: 70, bookmakers: [{}], best: { h2h: { home: { odds: 2.1, bookmaker: "B" }, draw: { odds: 3.2, bookmaker: "B" }, away: { odds: 3.6, bookmaker: "B" } }, totals: {}, spreads: {} } };
  let analysis = analyseFixture(fx, context, odds, config, null);                      // exactly how app.js calls it (5 arguments)
  analysis.shadow = buildDualShadow(fx, context, analysis.consensusProbability);
  const state = { results: [analysis] }, hist = history();
  const stored = NOW;
  updatePredictionSnapshots(files.pred, state.results, stored);
  const shadowStats = updateDualShadowHistory(files.dual, state.results, hist, stored);
  const observed = observeRatingsShadow({ file: files.ratings, results: state.results, history: hist, now: stored, enabled });
  return { state, shadowStats, dual: fs.existsSync(files.dual) ? fs.readFileSync(files.dual) : null, pred: fs.existsSync(files.pred) ? fs.readFileSync(files.pred) : null, ratingsExists: fs.existsSync(files.ratings), observed };
}
test("Production identity: results, statistics and existing Shadow files are byte-identical with the observer on and off", () => {
  const off = productionCycle(false), on = productionCycle(true);
  assert.equal(off.observed.status, "DISABLED"); assert.equal(on.observed.status, "OK"); assert.equal(on.observed.written, 1);
  assert.equal(sha(on.state.results), sha(off.state.results), "category, probabilities, signals, markets unchanged");
  assert.equal(sha(on.shadowStats), sha(off.shadowStats));
  assert.ok(on.dual.equals(off.dual) && on.pred.equals(off.pred));
  assert.equal(off.ratingsExists, false); assert.equal(on.ratingsExists, true);
});

// ---- hook patch
const appPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../src/app.js");
// works both on the plain app.js and on one where the hook is already applied: the hook lines all carry MARKER
const readOriginalApp = () => fs.readFileSync(appPath, "utf8").split("\n").filter(line => !line.includes(MARKER)).join("\n");
test("hook applier: three anchored insertions, idempotent, reversible, syntactically valid, no write to state", () => {
  const original = readOriginalApp(), result = applyHook(original);
  assert.ok(result.changed && result.source.split(MARKER).length === 6, "import, constant and the three lines of the call are each marked");
  assert.equal(applyHook(result.source).changed, false);
  const reverted = result.source.split("\n").filter(line => !line.includes(MARKER)).join("\n");
  assert.equal(reverted, original, "removing the added lines restores app.js exactly");
  const start = result.source.indexOf("try{observeRatingsShadow"), call = result.source.slice(start, result.source.indexOf("}catch{}", start) + 8);
  assert.ok(!/\bstate\s*\.\w+\s*=|\bawait\b|\bresults\s*=/.test(call), "the call neither assigns to state nor awaits");
  const v3 = result.source.indexOf("updateV3ShadowHistory(V3_SHADOW"), hook = result.source.indexOf("try{observeRatingsShadow"), after = result.source.indexOf("state.providers.apiFootball=getApiFootballTelemetry(env.REFRESH_MINUTES||30);\n    if(state.providers.history");
  assert.ok(v3 > 0 && hook > v3 && hook < after, "hook sits after the V3 block and before the telemetry/save part");
  const dir = tmp(), copy = path.join(dir, "app.mjs"); fs.writeFileSync(copy, result.source);
  const check = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" }); assert.equal(check.status, 0, check.stderr);
});

test("hook applier survives local edits around the anchors and aborts (writing nothing) when an anchor is gone", () => {
  const original = readOriginalApp();
  const edited = original.replace("const V3_SHADOW_HISTORY_FILE", "const BASE_K0_SHADOW_FILE=path.join(DATA,'statistics','base-candidate-shadow.jsonl');\nconst V3_SHADOW_HISTORY_FILE").replace("    state.providers.apiFootball=getApiFootballTelemetry(env.REFRESH_MINUTES||30);\n    if(state.providers.history", "    /* local shadow k=0/k=8 call */ void 0;\n    state.providers.apiFootball=getApiFootballTelemetry(env.REFRESH_MINUTES||30);\n    if(state.providers.history");
  assert.ok(applyHook(edited).changed);
  const broken = original.replace("state.v3ShadowStatistics=updateV3ShadowHistory(", "state.v3ShadowStatistics=somethingElse(");
  const out = applyHook(broken); assert.equal(out.changed, false); assert.match(out.reason, /anchor not found/); assert.equal(out.source, broken);
});

test("isolation: only the observer is imported by the hook; production modules never import ratings code", () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "../src");
  const offenders = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!p.endsWith(path.join("shadow", "ratings"))) walk(p); } else if (/\.js$/.test(e.name) && /shadow\/ratings/.test(fs.readFileSync(p, "utf8")) && !p.endsWith("app.js")) offenders.push(p); } })(root);
  assert.deepEqual(offenders, []);
  const observer = fs.readFileSync(path.join(root, "shadow/ratings/ratingsObserver.js"), "utf8");
  assert.ok(!/from "\.\.\/\.\.\/(engine|ui|storage|statistics)|from "\.\.\/(dualShadow|challenger|baselineV2H|v3)/.test(observer));
});

test("the inserted call hands the cycle's own objects to the observer and honours the flag values", () => {
  const result = applyHook(readOriginalApp()), start = result.source.indexOf("try{observeRatingsShadow");
  const snippet = result.source.slice(start, result.source.indexOf("}catch{}", start) + 8);
  const run = flag => { const calls = [], state = { results: [{ id: "x" }] }, history = [{ h: 1 }]; new Function("observeRatingsShadow", "RATINGS_V1_SHADOW_FILE", "state", "completedHistory", "storedAt", "env", snippet)(a => { calls.push(a); return {}; }, "/f.jsonl", state, history, "2026-10-20T10:00:00.000Z", flag === undefined ? {} : { RATINGS_V1_SHADOW: flag }); assert.equal(calls[0].results, state.results); assert.equal(calls[0].history, history); assert.equal(calls[0].now, "2026-10-20T10:00:00.000Z"); assert.equal(calls[0].file, "/f.jsonl"); return calls[0].enabled; };
  assert.deepEqual(["1", "true", "YES", "0", "", "off", undefined].map(run), [true, true, true, false, false, false, false]);
  const throwing = new Function("observeRatingsShadow", "RATINGS_V1_SHADOW_FILE", "state", "completedHistory", "storedAt", "env", snippet);
  assert.doesNotThrow(() => throwing(() => { throw new Error("observer bug"); }, "/f", { results: [] }, [], "x", { RATINGS_V1_SHADOW: "1" }), "even a throwing observer cannot escape the hook");
});
