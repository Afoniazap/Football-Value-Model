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

function daysSinceLastMatch(teamId, targetMatch, previousMatches) {
  const previous = [...previousMatches]
    .reverse()
    .find(match => match.homeTeamId === teamId || match.awayTeamId === teamId);
  if (!previous) return null;
  const diffMs = new Date(targetMatch.utcDate).getTime() - new Date(previous.utcDate).getTime();
  return diffMs / 86_400_000;
}

export function assertNoTemporalLeakage(targetMatch, historicalMatches) {
  const targetTime = new Date(targetMatch.utcDate).getTime();
  const leaking = (historicalMatches || []).filter(match =>
    new Date(match.utcDate).getTime() >= targetTime
  );
  if (leaking.length) {
    throw new Error(`Temporal leakage: ${leaking.length} matches are not before target kickoff`);
  }
}

export function matchesBefore(targetMatch, historicalMatches) {
  const targetTime = new Date(targetMatch.utcDate).getTime();
  return (historicalMatches || [])
    .filter(match => new Date(match.utcDate).getTime() < targetTime)
    .sort((a, b) => {
      const timeDiff = new Date(a.utcDate) - new Date(b.utcDate);
      if (timeDiff) return timeDiff;
      return String(a.fixtureId).localeCompare(String(b.fixtureId));
    });
}

export function createPreMatchContext(targetMatch, historicalMatches) {
  const previousMatches = matchesBefore(targetMatch, historicalMatches);
  assertNoTemporalLeakage(targetMatch, previousMatches);

  const tableByTeam = new Map();
  const homeTableByTeam = new Map();
  const awayTableByTeam = new Map();
  for (const match of previousMatches) {
    addResult(ensureTeam(tableByTeam, match.homeTeamId), match.homeGoals, match.awayGoals);
    addResult(ensureTeam(tableByTeam, match.awayTeamId), match.awayGoals, match.homeGoals);
    addResult(ensureTeam(homeTableByTeam, match.homeTeamId), match.homeGoals, match.awayGoals);
    addResult(ensureTeam(awayTableByTeam, match.awayTeamId), match.awayGoals, match.homeGoals);
  }

  const contextMatches = previousMatches.map(match => ({
    id: match.fixtureId,
    utcDate: match.utcDate,
    homeTeam: { id: match.homeTeamId, name: match.homeTeam },
    awayTeam: { id: match.awayTeamId, name: match.awayTeam },
    score: {
      fullTime: {
        home: match.homeGoals,
        away: match.awayGoals
      }
    }
  }));

  return {
    standings: {
      standings: [
        {
          type: "TOTAL",
          table: [...tableByTeam.values()]
        },
        {
          type: "HOME",
          table: [...homeTableByTeam.values()]
        },
        {
          type: "AWAY",
          table: [...awayTableByTeam.values()]
        }
      ]
    },
    matches: contextMatches,
    meta: {
      targetFixtureId: targetMatch.fixtureId,
      snapshotAt: targetMatch.utcDate,
      sourceMatches: previousMatches.length,
      restDays: {
        home: daysSinceLastMatch(targetMatch.homeTeamId, targetMatch, previousMatches),
        away: daysSinceLastMatch(targetMatch.awayTeamId, targetMatch, previousMatches)
      }
    }
  };
}

export function toModelFixture(match) {
  return {
    id: match.fixtureId,
    competitionCode: match.competitionCode,
    competition: match.competition,
    utcDate: match.utcDate,
    home: match.homeTeam,
    away: match.awayTeam,
    homeId: match.homeTeamId,
    awayId: match.awayTeamId,
    matchday: null
  };
}

export function rejectionReason(match, context, minRecent = 3) {
  const table = context?.standings?.standings?.[0]?.table || [];
  const home = table.find(row => row.team?.id === match.homeTeamId);
  const away = table.find(row => row.team?.id === match.awayTeamId);
  if (!home || !away) return "MISSING_STANDINGS";

  const countRecent = teamId => (context.matches || [])
    .filter(item => item.homeTeam?.id === teamId || item.awayTeam?.id === teamId)
    .length;

  if (countRecent(match.homeTeamId) < minRecent || countRecent(match.awayTeamId) < minRecent) {
    return "INSUFFICIENT_HISTORY";
  }
  return null;
}
