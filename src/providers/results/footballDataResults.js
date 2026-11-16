import { errorResult, providerResult, SourceStatus } from "../providerResult.js";
import { regulationScore } from "../footballDataScore.js";

function resultFromScore(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "H";
  if (homeGoals < awayGoals) return "A";
  return "D";
}

function normalizeFinishedResult(match) {
  if (match.status !== "FINISHED") return null;
  // Markets settle on the 90-minute score; fullTime includes extra time and penalties.
  const regulation = regulationScore(match);
  if (!regulation) return null;
  const { home: homeGoals, away: awayGoals } = regulation;
  return {
    fixtureId: String(match.id),
    homeGoals,
    awayGoals,
    result: resultFromScore(homeGoals, awayGoals),
    duration: regulation.duration,
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
