function emptyTeamStats(teamId) {
  return {
    team: { id: teamId },
    playedGames: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0
  };
}

function ensureTeam(map, teamId) {
  if (!map.has(teamId)) map.set(teamId, emptyTeamStats(teamId));
  return map.get(teamId);
}

function addResult(row, scored, conceded) {
  row.playedGames += 1;
  row.goalsFor += scored;
  row.goalsAgainst += conceded;
  row.goalDifference = row.goalsFor - row.goalsAgainst;
  if (scored > conceded) row.points += 3;
  else if (scored === conceded) row.points += 1;
}

function splitTables(matches = []) {
  const home = new Map();
  const away = new Map();

  for (const match of matches) {
    const homeTeamId = match.homeTeam?.id;
    const awayTeamId = match.awayTeam?.id;
    const homeGoals = Number(match.score?.fullTime?.home);
    const awayGoals = Number(match.score?.fullTime?.away);
    if (!homeTeamId || !awayTeamId || !Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;

    addResult(ensureTeam(home, homeTeamId), homeGoals, awayGoals);
    addResult(ensureTeam(away, awayTeamId), awayGoals, homeGoals);
  }

  return {
    home: [...home.values()],
    away: [...away.values()]
  };
}

export function createLivePreMatchContext(context) {
  const standings = context?.standings?.standings || [];
  const hasHome = standings.some(item => item.type === "HOME");
  const hasAway = standings.some(item => item.type === "AWAY");
  if (hasHome && hasAway) return context;

  const splits = splitTables(context?.matches || []);
  return {
    ...context,
    standings: {
      ...context?.standings,
      standings: [
        ...standings,
        ...(hasHome ? [] : [{ type: "HOME", table: splits.home }]),
        ...(hasAway ? [] : [{ type: "AWAY", table: splits.away }])
      ]
    }
  };
}
