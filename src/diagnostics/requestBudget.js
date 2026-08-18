const DEFAULT_DAILY_BUDGETS = Object.freeze({
  footballData: 1000,
  theOddsApi: 500,
  oddsApiIo: 500,
  apiFootball: 100
});

export function refreshesPerDay(refreshMinutes) {
  return refreshMinutes > 0 ? Math.ceil((24 * 60) / refreshMinutes) : 0;
}

export function projectRequestBudget({ requestCounts = {}, refreshMinutes = 30, budgets = DEFAULT_DAILY_BUDGETS }) {
  const multiplier = refreshesPerDay(refreshMinutes);
  const providers = Object.fromEntries(Object.entries({
    footballData: requestCounts.footballData || requestCounts.httpHosts?.["api.football-data.org"] || 0,
    theOddsApi: requestCounts.theOddsApi || requestCounts.httpHosts?.["api.the-odds-api.com"] || 0,
    oddsApiIo: requestCounts.oddsApiIo || requestCounts.httpHosts?.["api.odds-api.io"] || 0,
    apiFootball: requestCounts.apiFootball || requestCounts.httpHosts?.["v3.football.api-sports.io"] || 0
  }).map(([provider, perRefresh]) => {
    const projectedPerDay = perRefresh * multiplier;
    const budget = budgets[provider] || null;
    return [provider, {
      perRefresh,
      projectedPerDay,
      budget,
      warning: budget && projectedPerDay >= budget * 0.8 ? "QUOTA_RISK" : null
    }];
  }));
  return { refreshesPerDay: multiplier, providers };
}
