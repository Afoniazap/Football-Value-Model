// Shadow-only adapter for ratings-v1. Not wired into app.js. Writes ONLY to the file it is given (append-only),
// never touches production statistics, categories, thresholds or Telegram, and swallows its own failures.
import fs from "node:fs";
import path from "node:path";
import { canonicalTeamIdentity, canonicalTeamName } from "../../history/teamAliases.js";
import { RATINGS_V1_PARAMS } from "./ratingsParams.js";
import { buildStateAsOf, predict, seasonLabel } from "./ratingsCore.js";

export const RATINGS_SHADOW_TYPE = "RATINGS_SHADOW_PREDICTION";
const FINISHED = new Set(["FT", "AET", "PEN", "FINISHED"]);

/** Same fixture key as dualShadow.js, so records can be joined with Production/Challenger/V2H/market records of the same fixture. */
export const fixtureKey = row => `${String(row.kickoff || row.utcDate || "").slice(0, 16)}|${canonicalTeamName(row.home)}|${canonicalTeamName(row.away)}`;
export const snapshotKey = (row, params = RATINGS_V1_PARAMS) => `${fixtureKey(row)}|ratings-v1`;

/** history rows (sqliteHistory.loadAllHistory shape) -> core matches. Same match stored under two spellings is collapsed (FOOTBALL_DATA preferred). */
export function historyRowsToMatches(history) {
  const byKey = new Map();
  for (const row of history || []) {
    const league = row.competition?.code, hg = Number(row.score?.fullTime?.home), ag = Number(row.score?.fullTime?.away);
    if (!league || !Number.isFinite(hg) || !Number.isFinite(ag) || !FINISHED.has(String(row.status || "FINISHED").toUpperCase())) continue;
    const homeId = canonicalTeamIdentity(row.homeTeam?.name), awayId = canonicalTeamIdentity(row.awayTeam?.name);
    if (!homeId || !awayId) continue;
    const kickoff = new Date(row.playedAt).toISOString(), id = `${league}|${kickoff.slice(0, 16)}|${homeId}|${awayId}`;
    const previous = byKey.get(`${league}|${kickoff.slice(0, 10)}|${homeId}|${awayId}`);
    const preferred = (row.provenance?.source || row.provenance?.sources?.[0]) === "FOOTBALL_DATA";
    if (!previous || (preferred && !previous.preferred)) byKey.set(`${league}|${kickoff.slice(0, 10)}|${homeId}|${awayId}`, { id, league, season: seasonLabel(league, kickoff), kickoff, homeId, awayId, hg, ag, preferred });
  }
  return [...byKey.values()].map(({ preferred, ...match }) => match);
}

/** One shadow record for an upcoming fixture. `now` = the information time (prediction moment); results not yet available at `now` are ignored. */
export function buildRatingsPrediction({ fixture, matches, now, params = RATINGS_V1_PARAMS }) {
  const league = fixture.competitionCode, kickoff = new Date(fixture.utcDate || fixture.kickoff).toISOString();
  if (!league || new Date(kickoff) <= new Date(now)) return null;
  const state = buildStateAsOf(matches.filter(m => m.kickoff < kickoff), new Date(now).toISOString(), params);
  const homeId = canonicalTeamIdentity(fixture.home), awayId = canonicalTeamIdentity(fixture.away);
  const result = predict(state, { league, season: seasonLabel(league, kickoff), homeId, awayId });
  return {
    schemaVersion: 1, type: RATINGS_SHADOW_TYPE, snapshotKey: snapshotKey({ kickoff, home: fixture.home, away: fixture.away }),
    createdAt: new Date(now).toISOString(), kickoff, fixtureId: String(fixture.id ?? ""), home: fixture.home, away: fixture.away,
    competition: fixture.competition ?? null, competitionCode: league, model: "ratings-v1", ...result
  };
}

/** Append-only and idempotent by snapshotKey. Never rewrites an existing line. */
export function appendRatingsPredictions(file, records) {
  try {
    const existing = new Set(fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line).snapshotKey; } catch { return null; } }) : []);
    const fresh = [];
    for (const record of records || []) if (record && !existing.has(record.snapshotKey)) { existing.add(record.snapshotKey); fresh.push(record); }
    if (!fresh.length) return 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${fresh.map(r => JSON.stringify(r)).join("\n")}\n`, "utf8");
    return fresh.length;
  } catch { return 0; }   // a shadow failure must never reach the production cycle
}
