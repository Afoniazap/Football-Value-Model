import { SourceStatus } from "../providers/providerResult.js";

function component(name, score, max, status = SourceStatus.OK, note = "") {
  return { name, score, max, status, note };
}

function teamRow(context, teamId) {
  const table = context?.standings?.standings?.find(s => s.type === "TOTAL")?.table || [];
  return table.find(row => row.team?.id === teamId);
}

function recentGames(context, teamId) {
  return (context?.matches || [])
    .filter(m => m.homeTeam?.id === teamId || m.awayTeam?.id === teamId);
}

function squadCoverage(apiFootballResult) {
  if (!apiFootballResult || apiFootballResult.status === SourceStatus.NA) {
    return component("squadCoverage", 0, 10, SourceStatus.NA, "API-Football not connected or unavailable");
  }

  const data = apiFootballResult.data || {};
  const endpoints = apiFootballResult.meta?.endpoints || [];
  const injuriesOk = endpoints.find(x => x.endpoint === "injuries")?.status === SourceStatus.OK;
  const lineupsOk = endpoints.find(x => x.endpoint === "lineups")?.status === SourceStatus.OK;
  const confirmedBothLineups = Array.isArray(data.lineups) && data.lineups.length >= 2;

  return component(
    "squadCoverage",
    (injuriesOk ? 3 : 0) + (lineupsOk ? 3 : 0) + (confirmedBothLineups ? 4 : 0),
    10,
    apiFootballResult.status,
    confirmedBothLineups ? "Both lineups available" : "Confirmed lineups not available"
  );
}

export function calculateDataQuality({ fixture, context, oddsEvent, apiFootballResult }) {
  const home = teamRow(context, fixture.homeId);
  const away = teamRow(context, fixture.awayId);
  const homeGames = recentGames(context, fixture.homeId).length;
  const awayGames = recentGames(context, fixture.awayId).length;
  const minPlayed = Math.min(home?.playedGames || 0, away?.playedGames || 0);
  const minRecent = Math.min(homeGames, awayGames);
  const hasMarket = Boolean(oddsEvent);

  const components = [
    component("historicalSample", Math.min(20, minPlayed), 20, minPlayed ? SourceStatus.OK : SourceStatus.NA),
    component("freshness", minRecent >= 3 ? 10 : Math.round((minRecent / 3) * 10), 10, minRecent ? SourceStatus.OK : SourceStatus.NA),
    component("homeAwaySplits", home && away ? 8 : 0, 15, SourceStatus.PARTIAL, "Baseline has total table only, no true home/away split"),
    component("recentFormCoverage", Math.min(15, minRecent * 3), 15, minRecent ? SourceStatus.OK : SourceStatus.NA),
    component("marketCoverage", hasMarket ? 15 : 0, 15, hasMarket ? SourceStatus.OK : SourceStatus.NA),
    component("xgCoverage", 0, 15, SourceStatus.NA, "NOT CONNECTED"),
    squadCoverage(apiFootballResult)
  ];

  const availableComponents = components.filter(item =>
    !(item.name === "xgCoverage" && item.status === SourceStatus.NA)
  );
  const rawScore = components.reduce((sum, item) => sum + item.score, 0);
  const availableScore = availableComponents.reduce((sum, item) => sum + item.score, 0);
  const availableMax = availableComponents.reduce((sum, item) => sum + item.max, 0);
  const scoreNormalized = availableMax
    ? Math.round((availableScore / availableMax) * 100)
    : 0;

  return {
    scoreNormalized,
    rawScore,
    availableMax,
    components
  };
}
