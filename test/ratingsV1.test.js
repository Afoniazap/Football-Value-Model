import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createState, applyMatch, predict, runChronological, buildStateAsOf, resultAvailableAt, seasonLabel } from "../src/shadow/ratings/ratingsCore.js";
import { RATINGS_V1_PARAMS, RATINGS_V1_PARAMS_ID, RATINGS_V1_PARAMS_TRAIN_A, paramsId } from "../src/shadow/ratings/ratingsParams.js";
import { appendRatingsPredictions, buildRatingsPrediction, historyRowsToMatches, snapshotKey } from "../src/shadow/ratings/ratingsShadow.js";

const T = (day, hour = 15) => `2026-0${day < 100 ? 3 : 0}-${String(day % 100).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`.replace("2026-03", "2026-03");
function match(i, home, away, hg, ag, kickoff, extra = {}) { return { id: `m${i}`, league: "PL", season: "2025", kickoff, homeId: home, awayId: away, hg, ag, ...extra }; }
function league(n = 40) {
  // "strong" always beats everybody; "weak" always loses; others draw
  const teams = ["strong", "weak", "mid1", "mid2", "mid3", "mid4"], out = [];
  let i = 0, day = 1;
  for (let round = 0; round < n; round++) for (let a = 0; a < teams.length; a += 2) {
    const h = teams[(a + round) % 6], g = teams[(a + 1 + round * 2 + 1) % 6];
    if (h === g) continue;
    const hg = h === "strong" ? 3 : g === "strong" ? 0 : h === "weak" ? 0 : g === "weak" ? 2 : 1, ag = g === "strong" ? 3 : h === "strong" ? 0 : g === "weak" ? 0 : h === "weak" ? 2 : 1;
    out.push(match(i++, h, g, hg, ag, new Date(Date.UTC(2025, 8, 1 + Math.floor(i / 3), 15)).toISOString()));
  }
  return out;
}
const matches = league();
const fixtureAfter = (home, away, iso) => ({ league: "PL", season: "2025", homeId: home, awayId: away, kickoff: iso });

test("probabilities are valid and sum to one, for both heads", () => {
  const s = createState(); matches.forEach(m => applyMatch(s, m));
  const p = predict(s, fixtureAfter("strong", "weak"));
  for (const v of [p.probability, p.heads.poissonDc, p.heads.elo]) { assert.ok(Math.abs(v.home + v.draw + v.away - 1) < 1e-9); assert.ok([v.home, v.draw, v.away].every(x => x > 0 && x < 1)); }
});

test("learning is opponent-aware and monotone: strong team beats weak one more often than the reverse", () => {
  const s = createState(); matches.forEach(m => applyMatch(s, m));
  const a = predict(s, fixtureAfter("strong", "weak")).probability, b = predict(s, fixtureAfter("weak", "strong")).probability;
  assert.ok(a.home > 0.6 && b.away > 0.4 && a.home > b.home && a.away < b.away);
});

test("deterministic and independent of input order (bit-identical probabilities and state hash)", () => {
  const run = list => runChronological(list, { lagHours: 12 }).map(p => [p.id, JSON.stringify(p.probability), p.stateHash]);
  const shuffled = [...matches].sort((x, y) => (x.id < y.id ? 1 : -1));
  assert.deepEqual(run(matches), run(matches));
  assert.deepEqual(run(matches), run(shuffled));
});

test("no look-ahead: a later match (any score) cannot change an earlier prediction", () => {
  const base = runChronological(matches, { lagHours: 12 });
  const withFuture = [...matches, match(999, "strong", "weak", 0, 9, "2027-05-01T15:00:00.000Z")];
  const changed = runChronological(withFuture, { lagHours: 12 });
  for (const p of base) assert.deepEqual(changed.find(c => c.id === p.id).probability, p.probability);
  const target = matches[matches.length - 1];
  const rewritten = matches.map(m => (m.id === target.id ? { ...m, hg: 9, ag: 0 } : m));
  const before = runChronological(matches, { lagHours: 12 }).find(p => p.id === target.id);
  const after = runChronological(rewritten, { lagHours: 12 }).find(p => p.id === target.id);
  assert.deepEqual(before.probability, after.probability, "the result of the target itself is never used for its own prediction");
});

test("information lag: results that were not yet available at prediction time are not used", () => {
  const history = [match(1, "a", "b", 5, 0, "2026-01-10T15:00:00.000Z")];
  const target = match(2, "a", "c", 0, 0, "2026-01-10T20:00:00.000Z");          // kicks off 5h after the first match
  const zeroLag = runChronological([...history, target], { lagHours: 0, targets: ["m2"] })[0];
  const lag12 = runChronological([...history, target], { lagHours: 12, targets: ["m2"] })[0];
  const noHistory = runChronological([target], { lagHours: 0, targets: ["m2"] })[0];
  assert.equal(zeroLag.appliedMatches, 1, "kickoff+180min <= target kickoff: usable with zero lag");
  assert.equal(lag12.appliedMatches, 0, "12h lag excludes the match");
  assert.deepEqual(lag12.probability, noHistory.probability);
  assert.ok(resultAvailableAt(history[0]) === "2026-01-10T18:00:00.000Z");
});

test("buildStateAsOf honours the cutoff and rejects out-of-order or score-less matches", () => {
  const s = buildStateAsOf(matches, "2025-09-05T00:00:00.000Z");
  assert.ok(s.applied > 0 && s.applied < matches.length);
  assert.throws(() => applyMatch(createState(), { ...matches[0], hg: undefined }), /no final score/);
  const st = createState(); applyMatch(st, matches[5]);
  assert.throws(() => applyMatch(st, matches[0]), /older than the last applied/);
});

test("prediction is pure: predict() never mutates the state", () => {
  const s = createState(); matches.forEach(m => applyMatch(s, m));
  const snapshot = JSON.stringify([[...s.teams], [...s.elo], [...s.leagues], s.applied, s.hash]);
  predict(s, { ...fixtureAfter("strong", "weak"), season: "2026" }); predict(s, { league: "XX", season: "2026", homeId: "q", awayId: "r" });
  assert.equal(JSON.stringify([[...s.teams], [...s.elo], [...s.leagues], s.applied, s.hash]), snapshot);
});

test("season change shrinks ratings by the frozen carry factor; unseen teams are flagged", () => {
  const s = createState(); matches.forEach(m => applyMatch(s, m));
  const strong = s.teams.get("PL|strong").a, elo = s.elo.get("PL|strong");
  applyMatch(s, { id: "n1", league: "PL", season: "2026", kickoff: "2026-08-20T15:00:00.000Z", homeId: "mid1", awayId: "mid2", hg: 1, ag: 1 });
  assert.ok(Math.abs(s.teams.get("PL|strong").a - strong * RATINGS_V1_PARAMS.poisson.carry) < 1e-12);
  assert.ok(Math.abs(s.elo.get("PL|strong") - (1500 + (elo - 1500) * RATINGS_V1_PARAMS.elo.carry)) < 1e-12);
  const p = predict(s, { league: "PL", season: "2026", homeId: "newcomer", awayId: "strong" });
  assert.ok(p.flags.includes("NEW_TEAM") && p.flags.includes("LOW_DEPTH"));
  assert.equal(seasonLabel("PL", "2026-03-01T00:00:00Z"), "2025"); assert.equal(seasonLabel("BSA", "2026-03-01T00:00:00Z"), "2026");
});

test("hyper-parameters are frozen and identified by a stable hash (a change means a new version)", () => {
  assert.ok(Object.isFrozen(RATINGS_V1_PARAMS) && Object.isFrozen(RATINGS_V1_PARAMS.poisson) && Object.isFrozen(RATINGS_V1_PARAMS.elo));
  assert.equal(RATINGS_V1_PARAMS_ID, "ratings-v1.1:6ded2ce181f1");
  assert.notEqual(paramsId(RATINGS_V1_PARAMS_TRAIN_A), RATINGS_V1_PARAMS_ID);
});

test("isolation: the core is pure and nothing in the module reaches production code", () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "../src/shadow/ratings");
  const core = fs.readFileSync(path.join(dir, "ratingsCore.js"), "utf8");
  assert.ok(!/from "node:fs"|Date\.now\(|Math\.random|new Date\(\)|process\.env/.test(core), "core has no I/O, clock, randomness or env access");
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/engine\/(analyse|models|markets)|src\/app|ui\/telegram|statistics\/(marketBet|prediction)History|storage/.test(source), `${file} must not import production code`);
  }
});

test("shadow adapter: append-only, idempotent, writes only the given file, tolerates bad paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-ratings-")), file = path.join(dir, "ratings.jsonl");
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ playedAt: `2026-01-${String(i + 1).padStart(2, "0")}T15:00:00Z`, status: "FINISHED", competition: { code: "PL" }, homeTeam: { name: i % 2 ? "Alpha FC" : "Beta FC" }, awayTeam: { name: i % 2 ? "Beta FC" : "Alpha FC" }, score: { fullTime: { home: 2, away: 1 } }, provenance: { source: "FOOTBALL_DATA" } });
  rows.push({ ...rows[0], homeTeam: { name: "Beta" }, provenance: { source: "API_FOOTBALL" } });   // same match, other spelling
  const matches2 = historyRowsToMatches(rows);
  assert.equal(matches2.length, 12, "duplicate spelling collapsed");
  const fixture = { id: "9", home: "Alpha FC", away: "Beta FC", competitionCode: "PL", competition: "Premier League", utcDate: "2026-02-01T15:00:00Z" };
  const record = buildRatingsPrediction({ fixture, matches: matches2, now: "2026-02-01T08:00:00Z" });
  assert.equal(record.model, "ratings-v1"); assert.equal(record.paramsId, RATINGS_V1_PARAMS_ID);
  assert.equal(buildRatingsPrediction({ fixture, matches: matches2, now: "2026-02-01T16:00:00Z" }), null, "no prediction after kickoff");
  assert.equal(appendRatingsPredictions(file, [record]), 1);
  const bytes = fs.readFileSync(file);
  assert.equal(appendRatingsPredictions(file, [record]), 0, "idempotent");
  assert.ok(fs.readFileSync(file).equals(bytes));
  assert.deepEqual(fs.readdirSync(dir), ["ratings.jsonl"]);
  assert.equal(appendRatingsPredictions(path.join(file, "nested", "x.jsonl"), [record]), 0, "failure is swallowed");
  assert.ok(record.snapshotKey.endsWith("|ratings-v1") && record.snapshotKey === snapshotKey(fixture && { kickoff: fixture.utcDate, home: fixture.home, away: fixture.away }));
});
