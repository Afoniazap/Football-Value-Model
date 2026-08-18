import { errorResult, providerResult, SourceStatus } from "../providerResult.js";

function resultFromScore(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "H";
  if (homeGoals < awayGoals) return "A";
  return "D";
}

function normalizeFinishedResult(match) {
  const homeGoals = Number(match.score?.fullTime?.home);
  const awayGoals = Number(match.score?.fullTime?.away);
  if (match.status !== "FINISHED" || !Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  return {
    fixtureId: String(match.id),
    homeGoals,
    awayGoals,
    result: resultFromScore(homeGoals, awayGoals),
    finishedAt: match.lastUpdated || null,
    resultFetchedAt: new Date().toISOString()
  };
}

export async function fetchFinishedResults({ request, token, dateFrom, dateTo }) {
  const url = new URL("https://api.football-data.org/v4/matches");
  if (dateFrom) url.searchParams.set("dateFrom", dateFrom);
  if (dateTo) url.searchParams.set("dateTo", dateTo);
  url.searchParams.set("status", "FINISHED");

  try {
    const data = await request(url, { headers: { "X-Auth-Token": token } });
    const results = (data.matches || []).map(normalizeFinishedResult).filter(Boolean);
    return providerResult({
      status: results.length ? SourceStatus.OK : SourceStatus.NA,
      source: "football-data.results",
      data: results,
      meta: { dateFrom, dateTo, count: results.length }
    });
  } catch (error) {
    return errorResult("football-data.results", error, { dateFrom, dateTo });
  }
}
