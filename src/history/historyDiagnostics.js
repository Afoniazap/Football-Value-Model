import { canonicalTeamName, teamSearchAliases } from "./teamAliases.js";
import { getTeamAwayMatches, getTeamHomeMatches } from "./sqliteHistory.js";
import { MIN_GAMES_FOR_MATURE_STANDINGS } from "./competitionBaseline.js";

// Read-only diagnostics that separate three different reasons a fixture ends up
// without a usable Team Strength baseline: a REAL shortage of history, a team-name
// MATCHING gap (the history exists in SQLite under another spelling) and an
// immature HOME/AWAY split. Nothing here changes any model input: it only counts and
// labels rows that the existing, temporal-safe queries already return.

const MIN_TOKEN_LENGTH = 4;

function significantTokens(name) {
  return [...new Set(
    teamSearchAliases(name).flatMap(alias => canonicalTeamName(alias).split(" "))
      .filter(token => token.length >= MIN_TOKEN_LENGTH)
  )];
}

function countBy(rows, pick) {
  const out = {};
  for (const row of rows) {
    const key = pick(row) ?? "UNKNOWN";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Rows stored under a spelling that shares a significant word with `teamName` but is NOT
 * recognised as the same club (different normalized key). These are the candidates for an
 * alias gap. Only names and counts are returned (no ids, no scores).
 */
export function findUnmatchedNameVariants(db, teamName, before, { limit = 12 } = {}) {
  const tokens = significantTokens(teamName);
  if (!tokens.length) return [];
  const known = new Set(teamSearchAliases(teamName).map(canonicalTeamName));
  const likeSql = side => tokens.map(() => `${side}TeamNormalized LIKE ?`).join(" OR ");
  const likeArgs = tokens.map(token => `%${token}%`);
  const cutoff = new Date(before).toISOString();
  const rows = db.prepare(`
    SELECT name, normalized, source, competitionCode, COUNT(*) count FROM (
      SELECT homeTeam name, homeTeamNormalized normalized, source, competitionCode FROM matches WHERE kickoff < ? AND (${likeSql("home")})
      UNION ALL
      SELECT awayTeam name, awayTeamNormalized normalized, source, competitionCode FROM matches WHERE kickoff < ? AND (${likeSql("away")})
    ) GROUP BY name, normalized, source, competitionCode ORDER BY count DESC LIMIT ?
  `).all(cutoff, ...likeArgs, cutoff, ...likeArgs, 200);
  return rows
    .filter(row => !known.has(row.normalized))
    .slice(0, limit)
    .map(row => ({ name: row.name, source: row.source, competitionCode: row.competitionCode, matches: Number(row.count) }));
}

export function diagnoseTeamHistory(db, teamName, before, { limit = 20 } = {}) {
  const home = getTeamHomeMatches(db, { name: teamName }, before, limit);
  const away = getTeamAwayMatches(db, { name: teamName }, before, limit);
  const all = [...home, ...away];
  return {
    team: teamName,
    searchedKeys: [...new Set(teamSearchAliases(teamName).map(canonicalTeamName).filter(Boolean))],
    matched: { total: all.length, home: home.length, away: away.length },
    bySource: countBy(all, row => row.provenance?.source),
    byCompetition: countBy(all, row => row.competition?.code || row.competition?.name),
    unmatchedNameVariants: findUnmatchedNameVariants(db, teamName, before)
  };
}

/**
 * Pure classification of one side's history. `min` is the existing maturity bar
 * (MIN_GAMES_FOR_MATURE_STANDINGS) -- it is not a new or relaxed threshold.
 *   ENOUGH                 total and the relevant venue split both reach `min`
 *   VENUE_SPLIT_IMMATURE   enough games overall, venue-specific sample below `min`
 *   ALIAS_GAP_SUSPECTED    too few games, but rows exist under unmatched spellings
 *   REAL_HISTORY_SHORTAGE  too few games and nothing under any similar spelling
 */
export function classifyTeamHistory({ total, venue, unmatchedNameVariants = [] }, min = MIN_GAMES_FOR_MATURE_STANDINGS) {
  if (total >= min) return venue >= min ? "ENOUGH" : "VENUE_SPLIT_IMMATURE";
  return unmatchedNameVariants.length ? "ALIAS_GAP_SUSPECTED" : "REAL_HISTORY_SHORTAGE";
}

export function diagnoseFixtureHistory(db, fixture, { limit = 20 } = {}) {
  const home = diagnoseTeamHistory(db, fixture.home, fixture.utcDate, { limit });
  const away = diagnoseTeamHistory(db, fixture.away, fixture.utcDate, { limit });
  return {
    fixture: { home: fixture.home, away: fixture.away, competitionCode: fixture.competitionCode || null, utcDate: fixture.utcDate },
    minGamesForMatureSplit: MIN_GAMES_FOR_MATURE_STANDINGS,
    home: { ...home, venue: "HOME", classification: classifyTeamHistory({ total: home.matched.total, venue: home.matched.home, unmatchedNameVariants: home.unmatchedNameVariants }) },
    away: { ...away, venue: "AWAY", classification: classifyTeamHistory({ total: away.matched.total, venue: away.matched.away, unmatchedNameVariants: away.unmatchedNameVariants }) }
  };
}
