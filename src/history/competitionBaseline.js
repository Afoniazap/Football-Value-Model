import { getCompetitionSeasonMatches } from "./sqliteHistory.js";

// Aggregates already-imported SQLite rows for a whole competition/season into
// the same {team,playedGames,won,draw,lost,points,goalsFor,goalsAgainst,position}
// shape teamStrengthModel already reads via totalTable/homeTable/awayTable — so
// no change to the model formula is needed to consume a genuine, all-teams table
// instead of the two-team local-history fallback.
function buildTable(rows, mode = "TOTAL") {
  const teams = new Map();
  const get = (id, name) => {
    const key = String(id);
    if (!teams.has(key)) teams.set(key, { team: { id, name }, playedGames: 0, won: 0, draw: 0, lost: 0, points: 0, goalsFor: 0, goalsAgainst: 0 });
    return teams.get(key);
  };
  for (const row of rows) {
    const hg = row.score?.fullTime?.home, ag = row.score?.fullTime?.away;
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    if ((mode === "TOTAL" || mode === "HOME") && row.homeTeam?.id != null) {
      const h = get(row.homeTeam.id, row.homeTeam.name);
      h.playedGames++; h.goalsFor += hg; h.goalsAgainst += ag;
      if (hg > ag) { h.won++; h.points += 3; } else if (hg === ag) { h.draw++; h.points++; } else h.lost++;
    }
    if ((mode === "TOTAL" || mode === "AWAY") && row.awayTeam?.id != null) {
      const a = get(row.awayTeam.id, row.awayTeam.name);
      a.playedGames++; a.goalsFor += ag; a.goalsAgainst += hg;
      if (ag > hg) { a.won++; a.points += 3; } else if (ag === hg) { a.draw++; a.points++; } else a.lost++;
    }
  }
  return [...teams.values()]
    .sort((x, y) => y.points - x.points || (y.goalsFor - y.goalsAgainst) - (x.goalsFor - x.goalsAgainst) || y.goalsFor - x.goalsFor)
    .map((row, index) => ({ ...row, position: index + 1 }));
}

function standingsFrom(rows) {
  return { standings: [{ type: "TOTAL", table: buildTable(rows, "TOTAL") }, { type: "HOME", table: buildTable(rows, "HOME") }, { type: "AWAY", table: buildTable(rows, "AWAY") }] };
}

// A table built from only the two fixture teams is exactly what the existing
// two-team local-history fallback already produces — anything wider than that
// is a genuine, if still imperfect, competition-wide sample.
const MIN_TEAMS_FOR_GENUINE_BASELINE = 3;

/**
 * Tiered, unblended baseline: current season (all teams) first, then previous
 * season (all teams) only if current season has no more breadth than the
 * two-team fallback already gives, else null (caller keeps today's fallback).
 * No weighting between current/previous — that is shrinkage math, out of scope
 * here. Temporal safety is inherited from getCompetitionSeasonMatches's own
 * `kickoff < before` clause.
 */
// Always returns a diagnostic object (never bare null) so callers can expose
// sampleCurrentSeason/samplePreviousSeason even when neither tier qualifies as
// a genuine baseline; `standings` is null in that case and the caller decides
// the fallback (kept out of this module so it stays a pure data lookup).
export function buildCompetitionBaseline(db, competitionCode, currentSeasonStart, before) {
  if (!competitionCode || !currentSeasonStart) {
    return { baselineSource: "INSUFFICIENT", standings: null, baselineSample: 0, baselineTeams: 0, sampleCurrentSeason: 0, samplePreviousSeason: 0 };
  }

  const currentRows = getCompetitionSeasonMatches(db, competitionCode, currentSeasonStart, before);
  const currentTeams = new Set(currentRows.flatMap(r => [r.homeTeam?.id, r.awayTeam?.id]).filter(id => id != null));

  const previousSeasonStart = Number.isFinite(Number(currentSeasonStart)) ? String(Number(currentSeasonStart) - 1) : null;
  const previousRows = previousSeasonStart ? getCompetitionSeasonMatches(db, competitionCode, previousSeasonStart, before) : [];
  const previousTeams = new Set(previousRows.flatMap(r => [r.homeTeam?.id, r.awayTeam?.id]).filter(id => id != null));

  if (currentTeams.size >= MIN_TEAMS_FOR_GENUINE_BASELINE) {
    return { baselineSource: "CURRENT_SEASON", standings: standingsFrom(currentRows), baselineSample: currentRows.length, baselineTeams: currentTeams.size, sampleCurrentSeason: currentRows.length, samplePreviousSeason: previousRows.length };
  }
  if (previousTeams.size >= MIN_TEAMS_FOR_GENUINE_BASELINE) {
    return { baselineSource: "PREVIOUS_SEASON", standings: standingsFrom(previousRows), baselineSample: previousRows.length, baselineTeams: previousTeams.size, sampleCurrentSeason: currentRows.length, samplePreviousSeason: previousRows.length };
  }
  return { baselineSource: "INSUFFICIENT", standings: null, baselineSample: 0, baselineTeams: 0, sampleCurrentSeason: currentRows.length, samplePreviousSeason: previousRows.length };
}

/**
 * True only if BOTH fixture teams are actually resolvable in this (already
 * alignContextTeamIds-processed) standings table. Strict equality is
 * required: alignContextTeamIds only reassigns a matched row's id to the
 * fixture's own numeric homeId/awayId; every other row keeps the source
 * provider's own id verbatim (a string, from SQLite TEXT columns). A
 * different provider's numeric team id can otherwise coincidentally collide
 * with this fixture's id as a string, silently attributing an unrelated
 * team's record to this fixture.
 */
export function baselineCoversFixture(alignedStandings, fixture) {
  const table = alignedStandings?.standings?.find(s => s.type === "TOTAL")?.table || [];
  return table.some(row => row.team?.id === fixture.homeId) && table.some(row => row.team?.id === fixture.awayId);
}
