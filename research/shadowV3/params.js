// Parameter vector layout for the log-linear Dixon-Coles model. Team
// identity is scoped to (league, normalizedName) -- our 5 tracked leagues
// never share a team in this dataset, but scoping explicitly avoids relying
// on that as an unstated assumption.
export function buildParamIndex(matches) {
  const leagues = [...new Set(matches.map(m => m.league))].sort();
  const leagueIndex = new Map(leagues.map((l, i) => [l, i]));
  const teamKeys = new Set();
  for (const m of matches) {
    teamKeys.add(`${m.league}|${m.home}`);
    teamKeys.add(`${m.league}|${m.away}`);
  }
  const teams = [...teamKeys].sort();
  const teamIndex = new Map(teams.map((t, i) => [t, i]));
  return { leagues, leagueIndex, teams, teamIndex };
}

export function initParams(index) {
  return {
    mu: new Float64Array(index.leagues.length),
    ha: new Float64Array(index.leagues.length).fill(0.25), // mild positive prior, refined by MLE
    attack: new Float64Array(index.teams.length),
    defence: new Float64Array(index.teams.length),
    rho: 0
  };
}

export function teamKey(league, normalizedName) { return `${league}|${normalizedName}`; }

/** Enforces the model's one identifiability direction per league (see design
 * audit): (attack_i, defence_i) -> (attack_i + c, defence_i + c) for every
 * team in a league leaves every lambda unchanged. Re-centering so
 * mean(attack) == 0 per league removes that ambiguity WITHOUT touching any
 * lambda -- verified by a dedicated test (identifiability.test.js). */
export function reproject(params, index) {
  for (const league of index.leagues) {
    const li = index.leagueIndex.get(league);
    const teamIdxs = index.teams
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.startsWith(league + "|"))
      .map(({ i }) => i);
    if (!teamIdxs.length) continue;
    let sum = 0;
    for (const i of teamIdxs) sum += params.attack[i];
    const c = sum / teamIdxs.length;
    for (const i of teamIdxs) { params.attack[i] -= c; params.defence[i] -= c; }
  }
  return params;
}
