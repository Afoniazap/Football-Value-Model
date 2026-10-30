// Live-cycle observer for ratings-v1. It is a one-way tap: it READS the cycle's results and the already loaded history,
// WRITES only its own append-only JSONL, and NEVER throws, mutates its inputs, touches `state`, categories, signals, Telegram
// or production statistics. Disabled unless the caller passes enabled=true; also disabled at runtime by a kill file.
import fs from "node:fs";
import path from "node:path";
import { RATINGS_V1_PARAMS } from "./ratingsParams.js";
import { buildStateAsOf } from "./ratingsCore.js";
import { appendRatingsPredictions, buildRatingsRecord, historyRowsToMatches } from "./ratingsShadow.js";

export const RATINGS_SUPPORTED_LEAGUES = Object.freeze(["PL", "PD", "SA", "BL1", "FL1", "DED", "PPL", "ELC", "BSA"]);
export const RATINGS_KILL_FILE_NAME = "ratings-v1.DISABLED";
const MAX_FIXTURES_PER_CYCLE = 300;

/**
 * @param {object} o
 * @param {string}  o.file     target JSONL (append-only, e.g. data/statistics/ratings-v1-shadow.jsonl)
 * @param {Array}   o.results  production results of this cycle (read only)
 * @param {Array}   o.history  completed matches as returned by loadAllHistory (read only)
 * @param {string}  o.now      information time of this cycle (ISO); results not final at `now` are never used
 * @param {boolean} o.enabled  explicit opt-in (env RATINGS_V1_SHADOW)
 * @returns {{status:string, written?:number, considered?:number, skipped?:object, message?:string, ms?:number}}
 */
export function observeRatingsShadow({ file, results, history, now, enabled, params = RATINGS_V1_PARAMS, logger = console }) {
  const started = Date.now();
  try {
    if (!enabled) return { status: "DISABLED" };
    if (!file) return { status: "DISABLED", message: "no file" };
    if (fs.existsSync(path.join(path.dirname(file), RATINGS_KILL_FILE_NAME))) return { status: "KILLED" };
    const nowIso = new Date(now).toISOString();
    const matches = historyRowsToMatches(history);
    const state = buildStateAsOf(matches, nowIso, params);        // only matches whose result was final at `now`
    const skipped = { past: 0, unsupportedLeague: 0, invalid: 0 };
    const records = [];
    for (const fixture of (results || []).slice(0, MAX_FIXTURES_PER_CYCLE)) {
      const kickoff = Date.parse(fixture?.utcDate);
      if (!fixture || !Number.isFinite(kickoff) || !fixture.home || !fixture.away) { skipped.invalid++; continue; }
      if (kickoff <= Date.parse(nowIso)) { skipped.past++; continue; }
      if (!RATINGS_SUPPORTED_LEAGUES.includes(fixture.competitionCode)) { skipped.unsupportedLeague++; continue; }
      const record = buildRatingsRecord({ fixture, state, now: nowIso });
      if (record) records.push(record);
    }
    const written = appendRatingsPredictions(file, records);      // idempotent by snapshotKey, never rewrites a line
    return { status: "OK", written, considered: records.length, skipped, ms: Date.now() - started };
  } catch (error) {
    try { logger?.warn?.(`[ratings-v1 shadow] ${error?.message || error}`); } catch { /* logging must not fail either */ }
    return { status: "ERROR", message: String(error?.message || error), ms: Date.now() - started };
  }
}
