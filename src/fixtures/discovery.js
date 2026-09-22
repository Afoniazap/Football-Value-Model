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

// Classifies an empty API-Football result using the staged counters the
// connector attaches to its own return value (events -> futureEvents ->
// supportedFixtures), so a genuinely empty provider response ("nothing
// scheduled today") is no longer indistinguishable from "plenty of fixtures,
// none in a competition we map" -- the latter is a mapping-coverage
// question, the former is not. Falls back to the old undifferentiated
// reason when diagnostics aren't present (e.g. a test double that returns a
// plain array) so existing callers are unaffected. No filtering rule here
// -- purely a description of counts discoverFixtures already computed.
function emptyApiFootballReason(diagnostics) {
  if (!diagnostics) return "API_FOOTBALL_EMPTY";
  if (diagnostics.events === 0) return "API_FOOTBALL_NO_EVENTS";
  if (diagnostics.futureEvents === 0) return "API_FOOTBALL_NO_FUTURE_EVENTS";
  if (diagnostics.supportedFixtures === 0) return "API_FOOTBALL_NO_SUPPORTED_FIXTURES";
  // supportedFixtures > 0 but discoverFixtures' own usableFixture filter
  // (home/away present, still inside [now,end]) removed every one of
  // them -- a real, distinct scenario from the three above.
  return "API_FOOTBALL_NO_USABLE_FIXTURES";
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
    const raw = await apiFootball(apiKey, horizonHours);
    const fixtures = raw.filter(row => usableFixture(row, now, end));
    if (fixtures.length) return { fixtures, health };
    health.status = "DEGRADED";
    health.reason = emptyApiFootballReason(raw.diagnostics);
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
