import { canonicalTeamName, teamSearchAliases } from "./teamAliases.js";
import { getTeamAwayMatches, getTeamHomeMatches } from "./sqliteHistory.js";
import { MIN_GAMES_FOR_MATURE_STANDINGS, buildCompetitionBaseline, pickCompetitionBaseline } from "./competitionBaseline.js";
import { alignContextTeamIds } from "../engine/contextIds.js";

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

function competitionTriples(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.competition?.code ?? null, row.competition?.name ?? null, row.competition?.season ?? null].join("|");
    const group = groups.get(key) || { code: row.competition?.code ?? null, name: row.competition?.name ?? null, season: row.competition?.season ?? null, matches: 0 };
    group.matches += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.matches - a.matches);
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
    // Exact (code | name | season) triples as stored: shows code/name variants such as
    // DED vs "Eredivisie" and non-league competitions (CL) side by side.
    competitions: competitionTriples(all),
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

/**
 * Which competition baseline tier (current / previous season) would be used for the fixture,
 * and why not. Only the rows of `fixture.competitionCode` enter a baseline (other competitions
 * such as CL never do); the tiers are the SAME ones the live pipeline builds and picks.
 */
export function diagnoseBaseline(db, fixture, season = null) {
  const seasonStart = season || String(new Date(fixture.utcDate).getUTCFullYear());
  const raw = buildCompetitionBaseline(db, fixture.competitionCode, seasonStart, fixture.utcDate);
  const probe = { ...fixture, homeId: "__home__", awayId: "__away__" };
  const tierReport = (tier, label) => {
    if (!tier) return { tier: label, built: false };
    const aligned = alignContextTeamIds({ standings: tier.standings, finished: [], scheduled: [] }, {
      ...probe, homeId: "__home__", awayId: "__away__"
    });
    const find = type => aligned.standings.standings.find(group => group.type === type)?.table || [];
    const row = (type, id) => find(type).find(entry => entry.team?.id === id) || null;
    return {
      tier: label, built: true, sample: tier.baselineSample, teams: tier.baselineTeams,
      home: { total: row("TOTAL", "__home__")?.playedGames ?? 0, atHome: row("HOME", "__home__")?.playedGames ?? 0 },
      away: { total: row("TOTAL", "__away__")?.playedGames ?? 0, atAway: row("AWAY", "__away__")?.playedGames ?? 0 },
      picked: Boolean(pickCompetitionBaseline({ [label === "CURRENT_SEASON" ? "current" : "previous"]: tier }, probe, alignContextTeamIds))
    };
  };
  return {
    competitionCode: fixture.competitionCode, seasonStart,
    rowsCurrentSeason: raw.sampleCurrentSeason, rowsPreviousSeason: raw.samplePreviousSeason,
    current: tierReport(raw.current, "CURRENT_SEASON"), previous: tierReport(raw.previous, "PREVIOUS_SEASON")
  };
}

/**
 * Arithmetic breakdown of the existing Data Quality formula (engine/analyse.js
 * calculateDataQuality) -- component, value, maximum, and what drives it. Diagnostic only:
 * it reads the components the pipeline already computed and never recomputes or alters DQ.
 */
export function describeDataQuality(dataQualityV2, dataQuality = null) {
  const q = dataQualityV2 || {};
  const rows = [
    ["sampleScore", 20, "finished матчей в context ÷ 120 × 20"],
    ["freshnessScore", 10, "10, если в context есть хотя бы один finished матч"],
    ["homeAwayScore", 15, "15, если в standings есть и HOME, и AWAY таблицы"],
    ["formScore", 15, "15, если Form-модель рассчитана (≥4 матчей у каждой команды)"],
    ["marketScore", 15, "число букмекеров × 2.5, максимум 15"],
    ["xgScore", 0, "xG диагностический, в DQ не входит"],
    ["squadScore", 10, "травмы 3 + составы 3 + подтверждённые составы 4"]
  ].map(([key, max, rule]) => ({ component: key, value: Number.isFinite(q[key]) ? q[key] : null, max, rule, missing: Number.isFinite(q[key]) ? max - q[key] : null }));
  const total = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
  return { total: dataQuality ?? total, maxPossible: rows.reduce((sum, row) => sum + row.max, 0), components: rows };
}
