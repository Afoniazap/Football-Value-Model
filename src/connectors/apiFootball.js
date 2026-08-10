const BASE = "https://v3.football.api-sports.io";

async function getJson(path, key) {
  if (!key) return null;
  const response = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key }
  });
  if (!response.ok) throw new Error(`api-football ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function getFixtureRisk(key, apiFootballFixtureId) {
  if (!key || !apiFootballFixtureId) return null;
  const [injuries, lineups] = await Promise.all([
    getJson(`/injuries?fixture=${apiFootballFixtureId}`, key).catch(() => null),
    getJson(`/fixtures/lineups?fixture=${apiFootballFixtureId}`, key).catch(() => null)
  ]);
  return {
    injuries: injuries?.response || [],
    lineups: lineups?.response || []
  };
}
