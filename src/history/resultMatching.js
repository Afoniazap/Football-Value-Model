import { sameTeamIdentity } from "./teamAliases.js";
import { competitionsCompatible, teamIdentityLevel } from "./relaxedIdentity.js";

// Two independent matching paths, each with its own trust level and window.
//
// NAME path: team-name identity + kickoff proximity. A same-pair match can
// coincidentally exist at a very different date (a two-legged tie's other
// leg, the reverse home/away fixture from earlier/later in the season) —
// confirmed repeatedly in forensic audits — so this path stays tight: 12h.
//
// EXACT-ID path: same provider (API_FOOTBALL) reporting the same immutable
// fixtureId is a strictly stronger identity signal than name+time — it is
// the SAME real-world fixture regardless of how far its final kickoff drifted
// from the pre-match snapshot. Confirmed real gaps in our own provider cache
// (not hypothetical): Utrecht vs Go Ahead Eagles, fixtureId 1552155, status
// INT (interrupted) on 2026-09-05 -> FT (finished) on 2026-09-08, +3 days,
// same venue/referee; two PST(postponed)->FT reschedules at +7 days each;
// one PST->NS->FT reschedule at +15 days. 30 days is a deliberate ceiling —
// not "no limit" — comfortably covering every observed real case while still
// rejecting a coincidentally-reused ID paired with a wildly different date.
const NAME_MATCH_WINDOW_MS = 12 * 3600_000;
const EXACT_ID_MATCH_WINDOW_MS = 30 * 24 * 3600_000;
const EXACT_ID_SOURCE = "API_FOOTBALL";

// insertRow's own FINISHED filter (sqliteHistory.js) already keeps
// PST/INT/SUSP/ABD/CANC out of SQLite entirely — a row only ever reaches
// `history` once it has a final score. This check is deliberate
// defense-in-depth for the exact-ID path specifically: that path trusts a
// bare ID match far more than the name path does, so it must not lean on an
// upstream invariant alone.
// RELAXED path: spelling differences are tolerated, but kickoff must be (almost)
// identical because there is no ID or curated alias to anchor the identity.
const RELAXED_MATCH_WINDOW_MS = 30 * 60_000;

const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "FINISHED"]);

function scoreKey(row) {
  const home = row.score?.fullTime?.home, away = row.score?.fullTime?.away;
  return `${home}:${away}`;
}

function nearest(rows, kickoff) {
  return [...rows].sort((a, b) =>
    Math.abs(new Date(a.playedAt) - new Date(kickoff)) - Math.abs(new Date(b.playedAt) - new Date(kickoff))
  )[0] || null;
}

function summary(row, kickoff) {
  return {
    recordKey: row.recordKey || null,
    playedAt: row.playedAt,
    home: row.homeTeam?.name,
    away: row.awayTeam?.name,
    score: row.score?.fullTime ? { home: row.score.fullTime.home, away: row.score.fullTime.away } : null,
    source: row.provenance?.source || row.provenance?.sources?.[0] || null,
    sourceFixtureId: row.sourceFixtureId ?? null,
    competition: row.competition?.code || row.competition?.name || null,
    kickoffDeltaMinutes: Math.round((new Date(row.playedAt) - new Date(kickoff)) / 60000)
  };
}

/**
 * Resolves the history row for a prediction and says HOW it was matched.
 *
 * matchType:
 *   STRICT_ID     same provider + same immutable fixtureId (<= 30 days drift)
 *   STRICT_NAME   curated/canonical team identity on both sides, <= 12h
 *   RELAXED_NAME  only with options.allowRelaxed: spelling differences are
 *                 tolerated but kickoff <= 30 min, competition VERIFIED equal,
 *                 home/away orientation preserved, exactly one candidate
 *   null          no match; `reason` is NO_CANDIDATE, AMBIGUOUS_CANDIDATES or
 *                 CONFLICTING_SCORES. Ambiguous / conflicting input is never
 *                 graded automatically.
 */
export function resolveHistoryMatch(prediction, history, { allowRelaxed = false } = {}) {
  const kickoff = prediction.kickoff || prediction.utcDate;
  const strict = [];
  const relaxed = [];
  for (const row of history || []) {
    const delta = Math.abs(new Date(row.playedAt) - new Date(kickoff));
    const finished = FINISHED_STATUSES.has(String(row.status || "FINISHED").toUpperCase());
    const sources = [row.provenance?.source, ...(row.provenance?.sources || [])];

    const exactId = finished &&
      sources.includes(EXACT_ID_SOURCE) &&
      String(row.sourceFixtureId || "") === String(prediction.fixtureId) &&
      delta <= EXACT_ID_MATCH_WINDOW_MS;

    const byName = sameTeamIdentity(row.homeTeam?.name, prediction.home) &&
      sameTeamIdentity(row.awayTeam?.name, prediction.away) &&
      delta <= NAME_MATCH_WINDOW_MS;

    if (exactId || byName) {
      strict.push({ row, type: exactId ? "STRICT_ID" : "STRICT_NAME" });
      continue;
    }
    if (!allowRelaxed || !finished || delta > RELAXED_MATCH_WINDOW_MS) continue;
    const homeLevel = teamIdentityLevel(row.homeTeam?.name, prediction.home);
    const awayLevel = teamIdentityLevel(row.awayTeam?.name, prediction.away);
    if (!homeLevel || !awayLevel) continue;
    if (competitionsCompatible(prediction, row) !== true) continue;
    relaxed.push({ row, type: "RELAXED_NAME" });
  }

  const pool = strict.length ? strict : relaxed;
  if (!pool.length) return { row: null, matchType: null, reason: "NO_CANDIDATE", candidates: [] };
  const candidates = pool.map(item => summary(item.row, kickoff));
  if (new Set(pool.map(item => scoreKey(item.row))).size > 1) {
    return { row: null, matchType: null, reason: "CONFLICTING_SCORES", candidates };
  }
  if (!strict.length) {
    // Relaxed matches must resolve to ONE real match. Several rows are only
    // acceptable when they are the same fixture stored twice (same kickoff).
    if (new Set(pool.map(item => String(item.row.playedAt).slice(0, 16))).size > 1) {
      return { row: null, matchType: null, reason: "AMBIGUOUS_CANDIDATES", candidates };
    }
  }
  const chosen = nearest(pool.map(item => item.row), kickoff);
  const type = pool.find(item => item.row === chosen).type;
  return { row: chosen, matchType: type, reason: null, candidates, matched: summary(chosen, kickoff) };
}

/**
 * Backward-compatible wrapper: the single best history row, or null.
 * Shared by predictionHistory.js, marketBetHistory.js, dualShadow.js and
 * v3History.js. Relaxed matching is opt-in (`options.allowRelaxed`).
 */
export function matchHistoryRow(prediction, history, options = {}) {
  return resolveHistoryMatch(prediction, history, options).row;
}
