function expectedScore(ratingA, ratingB) {
  return 1 / (1 + (10 ** ((ratingB - ratingA) / 400)));
}

function actualScore(homeGoals, awayGoals, isHome) {
  if (homeGoals === awayGoals) return 0.5;
  const homeWon = homeGoals > awayGoals;
  return homeWon === isHome ? 1 : 0;
}

function ensureRating(ratings, teamId, initialRating) {
  if (!ratings.has(teamId)) ratings.set(teamId, initialRating);
  return ratings.get(teamId);
}

export function buildEloSnapshot(context, options = {}) {
  const initialRating = options.initialRating ?? 1500;
  const homeAdvantage = options.homeAdvantage ?? 65;
  const kFactor = options.kFactor ?? 20;
  const ratings = new Map();

  const matches = [...(context?.matches || [])]
    .sort((a, b) => {
      const timeDiff = new Date(a.utcDate) - new Date(b.utcDate);
      if (timeDiff) return timeDiff;
      return String(a.id).localeCompare(String(b.id));
    });

  for (const match of matches) {
    const homeId = match.homeTeam?.id;
    const awayId = match.awayTeam?.id;
    const homeGoals = Number(match.score?.fullTime?.home);
    const awayGoals = Number(match.score?.fullTime?.away);
    if (!homeId || !awayId || !Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;

    const homeRating = ensureRating(ratings, homeId, initialRating);
    const awayRating = ensureRating(ratings, awayId, initialRating);
    const expectedHome = expectedScore(homeRating + homeAdvantage, awayRating);
    const actualHome = actualScore(homeGoals, awayGoals, true);
    const delta = kFactor * (actualHome - expectedHome);
    ratings.set(homeId, homeRating + delta);
    ratings.set(awayId, awayRating - delta);
  }

  return { ratings, initialRating, homeAdvantage, kFactor };
}

export function eloDiagnostic(context, fixture, options = {}) {
  const snapshot = buildEloSnapshot(context, options);
  const homeRating = snapshot.ratings.get(fixture.homeId) ?? snapshot.initialRating;
  const awayRating = snapshot.ratings.get(fixture.awayId) ?? snapshot.initialRating;
  const expectedHome = expectedScore(homeRating + snapshot.homeAdvantage, awayRating);
  return {
    homeRating,
    awayRating,
    ratingDiff: homeRating - awayRating,
    expectedHome
  };
}
