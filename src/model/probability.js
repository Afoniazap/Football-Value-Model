function teamRow(context, teamId) {
  const table = context?.standings?.standings?.find(s => s.type === "TOTAL")?.table || [];
  return table.find(row => row.team?.id === teamId);
}

function recentForm(context, teamId, limit = 5) {
  const games = (context?.matches || [])
    .filter(m => m.homeTeam?.id === teamId || m.awayTeam?.id === teamId)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, limit);

  let points = 0;
  let gf = 0;
  let ga = 0;

  for (const match of games) {
    const isHome = match.homeTeam.id === teamId;
    const scored = Number(isHome ? match.score.fullTime.home : match.score.fullTime.away) || 0;
    const conceded = Number(isHome ? match.score.fullTime.away : match.score.fullTime.home) || 0;
    gf += scored;
    ga += conceded;
    if (scored > conceded) points += 3;
    else if (scored === conceded) points += 1;
  }
  return { games: games.length, points, gf, ga };
}

function softmax3(home, draw, away) {
  const values = [home, draw, away];
  const max = Math.max(...values);
  const exp = values.map(v => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / sum);
}

export function buildModel(fixture, context) {
  // INDEPENDENT MODEL - NO BOOKMAKER DATA.
  const home = teamRow(context, fixture.homeId);
  const away = teamRow(context, fixture.awayId);
  const homeForm = recentForm(context, fixture.homeId);
  const awayForm = recentForm(context, fixture.awayId);

  if (!home || !away || homeForm.games < 3 || awayForm.games < 3) {
    return {
      ...fixture,
      dataQuality: 48,
      category: "wait",
      reason: "Недостаточно данных таблицы или свежей формы.",
      model: null
    };
  }

  const hp = Math.max(home.playedGames || 1, 1);
  const ap = Math.max(away.playedGames || 1, 1);
  const ppgH = home.points / hp;
  const ppgA = away.points / ap;
  const gdH = home.goalDifference / hp;
  const gdA = away.goalDifference / ap;
  const formH = homeForm.points / (homeForm.games * 3);
  const formA = awayForm.points / (awayForm.games * 3);

  const strength =
    (ppgH - ppgA) * 0.65 +
    (gdH - gdA) * 0.22 +
    (formH - formA) * 0.75;

  const [pHome, pDraw, pAway] = softmax3(
    0.28 + strength,
    0.05 - Math.abs(strength) * 0.28,
    -strength
  );

  const avgGoalsH = (home.goalsFor + home.goalsAgainst) / hp;
  const avgGoalsA = (away.goalsFor + away.goalsAgainst) / ap;
  const expectedGoals = Math.max(1.4, Math.min(4.0, (avgGoalsH + avgGoalsA) / 2));

  const dataQuality = Math.round(
    Math.min(82, 55 + Math.min(hp, ap) * 0.7 + Math.min(homeForm.games, awayForm.games) * 2)
  );

  return {
    ...fixture,
    dataQuality,
    model: {
      home: pHome,
      draw: pDraw,
      away: pAway,
      expectedGoals,
      components: { ppgH, ppgA, gdH, gdA, formH, formA }
    }
  };
}
