function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function statRow(context, type, teamId) {
  const table = context?.standings?.standings?.find(item => item.type === type)?.table || [];
  return table.find(row => row.team?.id === teamId) || null;
}

function safeRate(goals, games, fallback) {
  return games > 0 ? goals / games : fallback;
}

export function leagueGoalRates(context) {
  const matches = context?.matches || [];
  const totals = matches.reduce((acc, match) => {
    acc.homeGoals += Number(match.score?.fullTime?.home) || 0;
    acc.awayGoals += Number(match.score?.fullTime?.away) || 0;
    acc.count += 1;
    return acc;
  }, { homeGoals: 0, awayGoals: 0, count: 0 });

  if (!totals.count) {
    return {
      homeGoalsPerGame: 1.35,
      awayGoalsPerGame: 1.1,
      goalsPerTeamGame: 1.225
    };
  }

  return {
    homeGoalsPerGame: totals.homeGoals / totals.count,
    awayGoalsPerGame: totals.awayGoals / totals.count,
    goalsPerTeamGame: (totals.homeGoals + totals.awayGoals) / (totals.count * 2)
  };
}

export function shrinkRate(rawRate, sampleSize, leagueAverage, shrinkageGames = 8) {
  const games = Math.max(0, sampleSize || 0);
  return ((rawRate * games) + (leagueAverage * shrinkageGames)) / (games + shrinkageGames);
}

export function teamRates(context, teamId, side, shrinkageGames = 8) {
  const league = leagueGoalRates(context);
  const total = statRow(context, "TOTAL", teamId);
  const split = statRow(context, side === "home" ? "HOME" : "AWAY", teamId);
  const games = split?.playedGames || 0;
  const forFallback = safeRate(total?.goalsFor || 0, total?.playedGames || 0, league.goalsPerTeamGame);
  const againstFallback = safeRate(total?.goalsAgainst || 0, total?.playedGames || 0, league.goalsPerTeamGame);
  const forAverage = side === "home" ? league.homeGoalsPerGame : league.awayGoalsPerGame;
  const againstAverage = side === "home" ? league.awayGoalsPerGame : league.homeGoalsPerGame;
  const rawFor = safeRate(split?.goalsFor || 0, games, forFallback);
  const rawAgainst = safeRate(split?.goalsAgainst || 0, games, againstFallback);

  return {
    games,
    rawFor,
    rawAgainst,
    scored: shrinkRate(rawFor, games, forAverage, shrinkageGames),
    conceded: shrinkRate(rawAgainst, games, againstAverage, shrinkageGames)
  };
}

export function expectedGoalsFromContext(context, fixture, options = {}) {
  const shrinkageGames = options.shrinkageGames ?? 8;
  const league = leagueGoalRates(context);
  const home = teamRates(context, fixture.homeId, "home", shrinkageGames);
  const away = teamRates(context, fixture.awayId, "away", shrinkageGames);

  const homeAttack = home.scored / league.homeGoalsPerGame;
  const awayDefense = away.conceded / league.homeGoalsPerGame;
  const awayAttack = away.scored / league.awayGoalsPerGame;
  const homeDefense = home.conceded / league.awayGoalsPerGame;

  return {
    lambdaHome: clamp(league.homeGoalsPerGame * homeAttack * awayDefense, 0.25, 3.2),
    lambdaAway: clamp(league.awayGoalsPerGame * awayAttack * homeDefense, 0.2, 2.8),
    league,
    home,
    away,
    components: {
      homeAttack,
      awayDefense,
      awayAttack,
      homeDefense,
      shrinkageGames
    }
  };
}
