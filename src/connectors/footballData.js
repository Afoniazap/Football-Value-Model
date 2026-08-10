const BASE = "https://api.football-data.org/v4";

async function getJson(url, token) {
  const response = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!response.ok) throw new Error(`football-data ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function getUpcomingMatches(token, horizonHours = 24) {
  const now = new Date();
  const end = new Date(now.getTime() + horizonHours * 3600_000);
  const date = d => d.toISOString().slice(0, 10);
  const url = `${BASE}/matches?dateFrom=${date(now)}&dateTo=${date(end)}`;
  const data = await getJson(url, token);

  return (data.matches || [])
    .filter(m => ["SCHEDULED", "TIMED"].includes(m.status))
    .filter(m => {
      const t = new Date(m.utcDate);
      return t > now && t <= end;
    })
    .map(m => ({
      id: String(m.id),
      competitionCode: m.competition?.code || "",
      competition: m.competition?.name || "Unknown",
      seasonStart: m.season?.startDate,
      matchday: m.matchday,
      utcDate: m.utcDate,
      home: m.homeTeam?.name || "Home",
      away: m.awayTeam?.name || "Away",
      homeId: m.homeTeam?.id,
      awayId: m.awayTeam?.id
    }));
}

export async function getCompetitionContext(token, code) {
  const [standings, finished, scheduled] = await Promise.all([
    getJson(`${BASE}/competitions/${code}/standings`, token).catch(() => null),
    getJson(`${BASE}/competitions/${code}/matches?status=FINISHED`, token).catch(() => ({ matches: [] })),
    getJson(`${BASE}/competitions/${code}/matches?status=SCHEDULED,TIMED`, token).catch(() => ({ matches: [] }))
  ]);
  return {
    standings,
    finished: (finished?.matches || []).slice(-500),
    scheduled: scheduled?.matches || []
  };
}
