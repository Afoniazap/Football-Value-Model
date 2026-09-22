// Shadow V3 persistence/grading -- own JSONL log, same append-only,
// restart-safe, deterministic-key discipline as src/shadow/dualShadow.js.
// Terminal types are V3_PREDICTION and V3_SKIPPED (UNSUPPORTED_COMPETITION
// is a permanent fact about the fixture) -- once written for a snapshotKey,
// never revisited, the same write-once-ever semantics dualShadow already
// uses. V3_FAILED is deliberately NOT terminal: a transient failure (DB
// briefly unavailable, a snapshot that hasn't converged yet) must not
// permanently deny a fixture its one shot at a V3 prediction before
// kickoff, so a fixture with only V3_FAILED events so far is retried on
// every tick until it either succeeds (one V3_PREDICTION, then terminal),
// gets skipped, or its kickoff passes (after which the creation loop below
// stops considering it at all). Multiple V3_FAILED events for the same
// fixture are expected and harmless -- they're diagnostic history, not an
// identity, and are never read by grading. This file NEVER mutates its
// `fixtures` argument and is always called AFTER Production's betting
// decision (category/best) is already finalized -- see the "Production
// identical V3 on/off" test.
import fs from "node:fs";
import path from "node:path";
import { canonicalTeamName } from "../history/teamAliases.js";
import { matchHistoryRow } from "../history/resultMatching.js";
import { getV3Snapshot, predictV3, V3_LEAGUES } from "./v3.js";

const KEYS = ["home", "draw", "away"];

function fixtureKey(row) { return `${String(row.utcDate || row.kickoff || "").slice(0, 16)}|${canonicalTeamName(row.home)}|${canonicalTeamName(row.away)}`; }
function snapshotKey(row) { return `${fixtureKey(row)}|v3-shadow-v1`; }
function read(file) { try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; } }
function append(file, rows) { if (!rows.length) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${rows.map(JSON.stringify).join("\n")}\n`, "utf8"); }
function actual(match) { const h = Number(match?.score?.fullTime?.home), a = Number(match?.score?.fullTime?.away); return !Number.isFinite(h) || !Number.isFinite(a) ? null : h > a ? "home" : h < a ? "away" : "draw"; }
function validProbability(p) { return p && KEYS.every(k => Number.isFinite(p[k])); }
function metrics(p, result) { const probability = Math.max(1e-12, p[result]); return { brier: KEYS.reduce((sum, k) => sum + (p[k] - (k === result ? 1 : 0)) ** 2, 0), logLoss: -Math.log(probability) }; }

/**
 * Reads/appends the V3 shadow log for the current refresh tick. `fixtures`
 * is the app's already-finalized results array (read-only here); `history`
 * is sqliteHistory.js's loadAllHistory() for grading; `dbPath` is the
 * SQLite file V3 trains from (a second, read-only connection -- see
 * research/shadowV3/dataset.js). Never throws: every internal failure mode
 * is caught by predictV3 itself and recorded as a V3_FAILED event.
 */
export function updateV3ShadowHistory(file, fixtures, history, now, dbPath) {
  const events = read(file);
  const known = new Set(events.filter(r => r.type === "V3_PREDICTION" || r.type === "V3_SKIPPED").map(r => r.snapshotKey));
  const graded = new Set(events.filter(r => r.type === "V3_RESULT").map(r => r.snapshotKey));
  const additions = [];
  let snapshot = null;

  for (const row of fixtures || []) {
    if (!row.utcDate || new Date(row.utcDate) <= new Date(now)) continue;
    const key = snapshotKey(row);
    if (known.has(key)) continue;
    const base = { schemaVersion: 1, snapshotKey: key, createdAt: now, kickoff: row.utcDate, fixtureId: String(row.id), home: row.home, away: row.away, competitionCode: row.competitionCode || null };

    if (!V3_LEAGUES.includes(row.competitionCode)) {
      additions.push({ ...base, type: "V3_SKIPPED", reason: "UNSUPPORTED_COMPETITION" });
      known.add(key); continue;
    }
    if (!snapshot) snapshot = getV3Snapshot(dbPath, new Date(now).getTime());
    const prediction = predictV3(row, snapshot);
    if (prediction.status === "PREDICTED") {
      additions.push({
        ...base, type: "V3_PREDICTION",
        modelVersion: prediction.modelVersion,
        snapshotCreatedAt: prediction.snapshotCreatedAt, trainingCutoff: prediction.trainingCutoff, trainedThrough: prediction.trainedThrough,
        trainingMatchCount: prediction.trainingMatchCount,
        halfLife: prediction.halfLife, priorVariance: prediction.priorVariance, rho: prediction.rho,
        lambdaHome: prediction.lambdaHome, lambdaAway: prediction.lambdaAway,
        probability: prediction.probability, independentPoissonProbability: prediction.independentPoissonProbability,
        tailMass: prediction.tailMass, matrixN: prediction.matrixN,
        unseenHome: prediction.unseenHome, unseenAway: prediction.unseenAway,
        homeIdentity: prediction.homeIdentity, awayIdentity: prediction.awayIdentity,
        productionProbability: validProbability(row.consensusProbability) ? { ...row.consensusProbability } : null
      });
    } else {
      additions.push({ ...base, type: "V3_FAILED", reason: prediction.reason || "unknown" });
    }
    known.add(key);
  }

  const allPredictions = [...events, ...additions].filter(r => r.type === "V3_PREDICTION");
  for (const prediction of allPredictions) {
    if (graded.has(prediction.snapshotKey) || new Date(prediction.kickoff) >= new Date(now)) continue;
    const match = matchHistoryRow(prediction, history);
    const result = actual(match);
    if (!result) continue;
    additions.push({
      schemaVersion: 1, type: "V3_RESULT", snapshotKey: prediction.snapshotKey, gradedAt: now,
      fixtureId: prediction.fixtureId, competitionCode: prediction.competitionCode, actual: result, score: match.score.fullTime,
      metrics: {
        v3: metrics(prediction.probability, result),
        independentPoisson: metrics(prediction.independentPoissonProbability, result),
        production: validProbability(prediction.productionProbability) ? metrics(prediction.productionProbability, result) : null
      },
      resultSource: match.provenance?.source || match.provenance?.sources?.[0] || "LOCAL_HISTORY"
    });
    graded.add(prediction.snapshotKey);
  }

  append(file, additions);
  return buildV3ShadowStatistics([...events, ...additions]);
}

function average(values) { const rows = values.filter(Number.isFinite); return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null; }
function summarize(results, key) {
  const graded = results.filter(r => r.metrics?.[key]);
  return { completed: graded.length, logLoss: average(graded.map(r => r.metrics[key].logLoss)), brier: average(graded.map(r => r.metrics[key].brier)) };
}
function byCompetition(results, key) {
  const codes = [...new Set(results.map(r => r.competitionCode).filter(Boolean))];
  return Object.fromEntries(codes.map(code => [code, summarize(results.filter(r => r.competitionCode === code), key)]));
}

export function buildV3ShadowStatistics(events) {
  const predictions = events.filter(r => r.type === "V3_PREDICTION");
  const skipped = events.filter(r => r.type === "V3_SKIPPED");
  const results = events.filter(r => r.type === "V3_RESULT");
  // V3_FAILED is retried every tick until it resolves (see updateV3ShadowHistory's
  // doc comment), so a single stuck fixture can have many V3_FAILED events --
  // count DISTINCT fixtures still stuck on failure, not raw event occurrences,
  // and exclude any fixture that has since gone on to succeed or be skipped.
  const predictedKeys = new Set(predictions.map(r => r.snapshotKey));
  const skippedKeys = new Set(skipped.map(r => r.snapshotKey));
  const stillFailingKeys = new Set(events.filter(r => r.type === "V3_FAILED" && !predictedKeys.has(r.snapshotKey) && !skippedKeys.has(r.snapshotKey)).map(r => r.snapshotKey));
  return {
    attempted: predictedKeys.size + skippedKeys.size + stillFailingKeys.size,
    predicted: predictions.length,
    skipped: skipped.length,
    failed: stillFailingKeys.size,
    pending: predictions.length - results.length,
    completed: results.length,
    trueUnseenFixtures: predictions.filter(r => r.unseenHome || r.unseenAway).length,
    unsupportedCompetitions: skipped.length,
    v3: summarize(results, "v3"),
    independentPoisson: summarize(results, "independentPoisson"),
    production: summarize(results, "production"),
    byCompetition: { v3: byCompetition(results, "v3"), independentPoisson: byCompetition(results, "independentPoisson"), production: byCompetition(results, "production") }
  };
}
export function loadV3ShadowStatistics(file) { return buildV3ShadowStatistics(read(file)); }
