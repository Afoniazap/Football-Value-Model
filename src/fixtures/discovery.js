function canonical(value = "") {
  return String(value).toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|cf|afc|sc|ac|cd|fk|rc|ca|ud|club)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function usableFixture(fixture, now, end) {
  const kickoff = new Date(fixture?.utcDate).getTime();
  return fixture?.home && fixture?.away && Number.isFinite(kickoff) && kickoff > now && kickoff <= end;
}

function fixtureKey(fixture) {
  const kickoff = new Date(fixture.utcDate).toISOString().slice(0, 16);
  return `${kickoff}|${canonical(fixture.home)}|${canonical(fixture.away)}`;
}

function previousFixtures(results, now, end) {
  return (results || []).filter(row => usableFixture(row, now, end)).map(row => ({
    id: row.id,
    apiFootballFixtureId: row.apiFootballFixtureId ?? null,
    apiFootballLeagueId: row.apiFootballLeagueId ?? null,
    competitionCode: row.competitionCode || "",
    competition: row.competition || "Unknown",
    country: row.country ?? null,
    seasonStart: row.seasonStart ?? null,
    matchday: row.matchday ?? null,
    utcDate: row.utcDate,
    home: row.home,
    away: row.away,
    homeId: row.homeId ?? null,
    awayId: row.awayId ?? null
  }));
}

function mergeFixtures(primary, secondary) {
  const merged = new Map();
  for (const fixture of [...primary, ...secondary]) {
    const key = fixtureKey(fixture);
    if (!merged.has(key)) merged.set(key, fixture);
  }
  return [...merged.values()].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
}

export async function discoverFixtures({
  apiKey,
  footballDataToken,
  horizonHours,
  previousResults = [],
  apiFootball,
  footballData,
  now = Date.now()
}) {
  const end = now + Number(horizonHours || 24) * 3600_000;
  const cached = previousFixtures(previousResults, now, end);
  const health = { primary: "API_FOOTBALL", status: "OK", source: "API_FOOTBALL", reason: null, cached: cached.length, alternatives: [] };

  try {
    const fixtures = (await apiFootball(apiKey, horizonHours)).filter(row => usableFixture(row, now, end));
    if (fixtures.length) return { fixtures, health };
    health.status = "DEGRADED";
    health.reason = "API_FOOTBALL_EMPTY";
  } catch (error) {
    health.status = "DEGRADED";
    health.reason = error?.code || error?.message || "API_FOOTBALL_ERROR";
  }

  let alternative = [];
  try {
    alternative = (await footballData(footballDataToken, horizonHours)).filter(row => usableFixture(row, now, end));
    health.alternatives.push({ source: "FOOTBALL_DATA", status: "OK", fixtures: alternative.length });
  } catch (error) {
    health.alternatives.push({ source: "FOOTBALL_DATA", status: "ERROR", reason: error?.message || "ERROR", fixtures: 0 });
  }

  const fixtures = mergeFixtures(cached, alternative);
  health.source = cached.length && alternative.length
    ? "CACHED_STATE+FOOTBALL_DATA"
    : cached.length ? "CACHED_STATE" : alternative.length ? "FOOTBALL_DATA" : null;
  health.fixtures = fixtures.length;
  return { fixtures, health };
}
