export function resultFromScore(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "H";
  if (homeGoals < awayGoals) return "A";
  return "D";
}

export function normalizeFinishedMatch(match, { season = null } = {}) {
  const homeGoals = Number(match.score?.fullTime?.home);
  const awayGoals = Number(match.score?.fullTime?.away);
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;

  return {
    fixtureId: String(match.id),
    competition: match.competition?.name || "Unknown",
    competitionCode: match.competition?.code || null,
    season,
    utcDate: match.utcDate,
    homeTeamId: match.homeTeam?.id,
    awayTeamId: match.awayTeam?.id,
    homeTeam: match.homeTeam?.name || "Home",
    awayTeam: match.awayTeam?.name || "Away",
    homeGoals,
    awayGoals,
    result: resultFromScore(homeGoals, awayGoals)
  };
}

export function normalizeFinishedMatches(matches, options = {}) {
  return (matches || [])
    .filter(match => match.status === "FINISHED")
    .map(match => normalizeFinishedMatch(match, options))
    .filter(Boolean);
}
