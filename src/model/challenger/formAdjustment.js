function teamGames(context, teamId, limit = 6) {
  return [...(context?.matches || [])]
    .filter(match => match.homeTeam?.id === teamId || match.awayTeam?.id === teamId)
    .sort((a, b) => {
      const timeDiff = new Date(b.utcDate) - new Date(a.utcDate);
      if (timeDiff) return timeDiff;
      return String(b.id).localeCompare(String(a.id));
    })
    .slice(0, limit);
}

function weightedRecentPoints(context, teamId, limit = 6, decay = 0.72) {
  const games = teamGames(context, teamId, limit);
  let weightedPoints = 0;
  let weightSum = 0;
  let weightedGoalDiff = 0;

  games.forEach((match, index) => {
    const isHome = match.homeTeam.id === teamId;
    const scored = Number(isHome ? match.score.fullTime.home : match.score.fullTime.away) || 0;
    const conceded = Number(isHome ? match.score.fullTime.away : match.score.fullTime.home) || 0;
    const points = scored > conceded ? 3 : scored === conceded ? 1 : 0;
    const weight = decay ** index;
    weightedPoints += points * weight;
    weightedGoalDiff += (scored - conceded) * weight;
    weightSum += weight;
  });

  return {
    games: games.length,
    pointsPerGame: weightSum ? weightedPoints / weightSum : 1,
    goalDiffPerGame: weightSum ? weightedGoalDiff / weightSum : 0
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function formLambdaFactors(context, fixture, options = {}) {
  const cap = options.cap ?? 0.08;
  const home = weightedRecentPoints(context, fixture.homeId, options.limit ?? 6, options.decay ?? 0.72);
  const away = weightedRecentPoints(context, fixture.awayId, options.limit ?? 6, options.decay ?? 0.72);
  const ppgDiff = ((home.pointsPerGame || 1) - (away.pointsPerGame || 1)) / 3;
  const gdDiff = ((home.goalDiffPerGame || 0) - (away.goalDiffPerGame || 0)) / 4;
  const effect = clamp((ppgDiff * 0.06) + (gdDiff * 0.03), -cap, cap);

  return {
    homeFactor: 1 + effect,
    awayFactor: 1 - effect,
    effect,
    cap,
    home,
    away
  };
}
