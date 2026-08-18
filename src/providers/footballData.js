import { errorResult, providerResult, SourceStatus } from "./providerResult.js";

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

export async function fetchFixtures({ request, token, horizonHours }) {
  const now = new Date();
  const horizon = new Date(now.getTime() + horizonHours * 3600_000);
  const url = new URL("https://api.football-data.org/v4/matches");
  url.searchParams.set("dateFrom", dateOnly(now));
  url.searchParams.set("dateTo", dateOnly(horizon));

  try {
    const data = await request(url, {
      headers: { "X-Auth-Token": token }
    });

    const fixtures = (data.matches || [])
      .filter(m => ["SCHEDULED", "TIMED"].includes(m.status))
      .filter(m => {
        const kickoff = new Date(m.utcDate);
        return kickoff > now && kickoff <= horizon;
      })
      .map(m => ({
        id: String(m.id),
        competitionCode: m.competition?.code,
        competition: m.competition?.name || "Unknown",
        utcDate: m.utcDate,
        home: m.homeTeam?.name || "Home",
        away: m.awayTeam?.name || "Away",
        homeId: m.homeTeam?.id,
        awayId: m.awayTeam?.id,
        matchday: m.matchday
      }));

    return providerResult({
      status: SourceStatus.OK,
      source: "football-data.fixtures",
      data: fixtures,
      meta: {
        horizonStart: now.toISOString(),
        horizonEnd: horizon.toISOString(),
        horizonHours
      }
    });
  } catch (error) {
    return errorResult("football-data.fixtures", error, {
      horizonStart: now.toISOString(),
      horizonEnd: horizon.toISOString(),
      horizonHours
    });
  }
}

export async function fetchCompetitionContext({ request, token, code }) {
  const source = code ? `football-data.context.${code}` : "football-data.context";

  if (!code) {
    return providerResult({
      status: SourceStatus.NA,
      source,
      data: null,
      meta: { code: null }
    });
  }

  try {
    const [standings, matches] = await Promise.all([
      request(`https://api.football-data.org/v4/competitions/${code}/standings`, {
        headers: { "X-Auth-Token": token }
      }),
      request(`https://api.football-data.org/v4/competitions/${code}/matches?status=FINISHED`, {
        headers: { "X-Auth-Token": token }
      })
    ]);

    return providerResult({
      status: SourceStatus.OK,
      source,
      data: {
        standings,
        matches: (matches.matches || []).slice(-300)
      },
      meta: { code }
    });
  } catch (error) {
    return errorResult(source, error, { code });
  }
}
