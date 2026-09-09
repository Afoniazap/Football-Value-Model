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

function tier(rows, label) {
  const teams = new Set(rows.flatMap(r => [r.homeTeam?.id, r.awayTeam?.id]).filter(id => id != null));
  if (teams.size < MIN_TEAMS_FOR_GENUINE_BASELINE) return null;
  return { baselineSource: label, standings: standingsFrom(rows), baselineSample: rows.length, baselineTeams: teams.size };
}

/**
 * Builds both candidate tiers independently — current season (all teams) and
 * previous season (all teams) — without picking or blending between them.
 * Picking happens per-fixture in pickCompetitionBaseline (below), because a
 * tier clearing the team-count bar is not the same as it covering THIS
 * fixture's two specific teams: a current-season tier assembled from several
 * not-yet-identity-reconciled providers can be wide (many rows) yet still
 * miss a given team that a cleaner, single-provider previous-season table
 * already has. No weighting between the two tiers — that is shrinkage math,
 * out of scope here. Temporal safety is inherited from
 * getCompetitionSeasonMatches's own `kickoff < before` clause.
 */
export function buildCompetitionBaseline(db, competitionCode, currentSeasonStart, before) {
  if (!competitionCode || !currentSeasonStart) {
    return { current: null, previous: null, sampleCurrentSeason: 0, samplePreviousSeason: 0 };
  }

  const currentRows = getCompetitionSeasonMatches(db, competitionCode, currentSeasonStart, before);
  const previousSeasonStart = Number.isFinite(Number(currentSeasonStart)) ? String(Number(currentSeasonStart) - 1) : null;
  const previousRows = previousSeasonStart ? getCompetitionSeasonMatches(db, competitionCode, previousSeasonStart, before) : [];

  return {
    current: tier(currentRows, "CURRENT_SEASON"),
    previous: tier(previousRows, "PREVIOUS_SEASON"),
    sampleCurrentSeason: currentRows.length,
    samplePreviousSeason: previousRows.length
  };
}

// Same per-team sample-size bar the two-team local-history fallback already
// requires before it trusts itself (localHistory.js's homeMatches>=4 &&
// awayMatches>=4, mirrored at app.js's localReady/hasLocalModelContext
// checks) — reused here rather than inventing a new number, because it is
// the project's existing answer to the same question: "is there enough
// real signal for THIS fixture's two specific teams". A live current-season
// standings table that exists but shows either team below this bar (e.g.
// matchday 1 of a new competition/season) is exactly as thin as the
// two-team fallback it currently outranks unconditionally, and must not
// block a genuinely wider competition/previous-season baseline just for
// technically being present.
const MIN_GAMES_FOR_MATURE_STANDINGS = 4;

/**
 * True only if BOTH fixture teams appear in this (already
 * alignContextTeamIds-processed) TOTAL table with at least
 * MIN_GAMES_FOR_MATURE_STANDINGS games played each. A table that is merely
 * non-null but reflects only 0-3 games for one of these two teams carries
 * almost no real signal — teamStrengthModel's attack/defence ratios on that
 * few games routinely collapse to the model's own λ clamp floor/ceiling
 * (proven: a 5-game/λ-floor case still needed an extreme goals ratio to
 * collapse, but 0-3 games collapses on ordinary, plausible scorelines).
 */
export function rawStandingsMature(alignedStandings, fixture) {
  const table = alignedStandings?.standings?.find(s => s.type === "TOTAL")?.table || [];
  const home = table.find(row => row.team?.id === fixture.homeId);
  const away = table.find(row => row.team?.id === fixture.awayId);
  return Boolean(
    home && away &&
    home.playedGames >= MIN_GAMES_FOR_MATURE_STANDINGS &&
    away.playedGames >= MIN_GAMES_FOR_MATURE_STANDINGS
  );
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

/**
 * Picks whichever tier actually covers this fixture's two teams AND is deep
 * enough for them specifically, preferring current season over previous when
 * both qualify. `alignFn` is alignContextTeamIds itself (injected so this
 * module never has to know about engine/contextIds.js's own dependency
 * chain).
 *
 * MIN_TEAMS_FOR_GENUINE_BASELINE (in `tier`, above) only bars a tier that is
 * NARROW — built from too few distinct teams competition-wide. It says
 * nothing about DEPTH: a tier can easily clear that bar (e.g. 26 teams) while
 * every one of those teams has played exactly one game — the competition's
 * opening matchday. teamStrengthModel's attack/defence ratios are exactly as
 * fragile on that single game as on a live table below
 * MIN_GAMES_FOR_MATURE_STANDINGS (proven: MLS 2026's opening-round baseline —
 * baselineSample=13, baselineTeams=26, every team's playedGames=1 —
 * collapsed λ to the clamp floor/ceiling for 5 fixtures and silently
 * degraded 3 more that happened not to hit both bounds at once). So a
 * candidate tier must pass the SAME fixture-specific depth bar already used
 * for the live table (rawStandingsMature), not just baselineCoversFixture's
 * plain presence/identity check, before it can be accepted here.
 */
export function pickCompetitionBaseline(baseline, fixture, alignFn) {
  for (const candidate of [baseline?.current, baseline?.previous]) {
    if (!candidate) continue;
    const aligned = alignFn({ standings: candidate.standings, finished: [], scheduled: [] }, fixture);
    if (baselineCoversFixture(aligned.standings, fixture) && rawStandingsMature(aligned.standings, fixture))
      return { ...candidate, standings: aligned.standings };
  }
  return null;
}

/**
 * Chooses which standings table feeds teamStrengthModel for one fixture,
 * given the raw live-API context. A live table wins only when it is mature
 * FOR THIS FIXTURE (rawStandingsMature); otherwise the SQLite competition
 * baseline (current season, then previous season — see pickCompetitionBaseline)
 * is tried, and if neither actually covers this fixture's two teams, the
 * live table's `standings` is cleared (not merely left thin) so the caller's
 * own two-team local-history fallback can correctly decide instead of being
 * pre-empted by a table that is merely non-null (09.09 forensic audit —
 * this replaces the old, unconditional "rawContext.standings always wins
 * when it exists" rule).
 */
export function resolveTeamStrengthBaseline(db, rawContext, fixture, alignFn, before) {
  const alignedRawContext = alignFn(rawContext, fixture);
  const liveStandingsMature = Boolean(alignedRawContext.standings) && rawStandingsMature(alignedRawContext.standings, fixture);
  const rawBaseline = !liveStandingsMature
    ? buildCompetitionBaseline(db, fixture.competitionCode, fixture.seasonStart, before)
    : null;
  const competitionBaseline = rawBaseline ? pickCompetitionBaseline(rawBaseline, fixture, alignFn) : null;
  const baseContext = competitionBaseline
    ? { ...rawContext, standings: competitionBaseline.standings }
    : liveStandingsMature
      ? alignedRawContext
      : { ...alignedRawContext, standings: null };
  return { baseContext, competitionBaseline, rawBaseline, liveStandingsMature };
}
