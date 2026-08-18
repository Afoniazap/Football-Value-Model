import {
  classifyXgHttpError,
  normalizeXgRecord,
  numberOrNull,
  xgCoverage,
  xgProviderResult,
  XG_STATUS
} from "./xgProvider.js";

const SOURCE = "SPORTMONKS_XG";
const BASE_URL = "https://api.sportmonks.com/v3/football";

function valuesByLocation(items = []) {
  const byLocation = { home: {}, away: {} };
  for (const item of items) {
    const location = item.location === "away" ? "away" : item.location === "home" ? "home" : null;
    if (!location) continue;
    const code = item.type?.code || item.type?.developer_name || item.type?.name || "";
    const normalized = String(code).toLowerCase();
    const value = numberOrNull(item.data?.value);
    if (!Number.isFinite(value)) continue;
    if (normalized.includes("non-penalty")) byLocation[location].npxG = value;
    else if (normalized.includes("against")) byLocation[location].xGA = value;
    else if (normalized === "expected-goals" || normalized.includes("expected goals (xg)") || normalized === "expected_goals") {
      byLocation[location].xG = value;
    }
  }
  return byLocation;
}

export function normalizeSportmonksFixture(payload, fixture = {}) {
  const data = payload?.data || payload || {};
  const values = valuesByLocation(data.xgfixture || data.xGFixture || []);
  const record = normalizeXgRecord({
    fixtureId: fixture.id || fixture.fixtureId || data.id,
    externalFixtureId: data.id || fixture.externalFixtureId,
    kickoff: fixture.utcDate || data.starting_at || data.kickoff,
    competition: fixture.competition || data.league?.name || data.competition,
    home: values.home,
    away: values.away,
    source: SOURCE,
    observedAt: new Date().toISOString(),
    status: XG_STATUS.OK,
    providerMeta: { providerFixtureId: data.id || null }
  });
  return { ...record, coverage: xgCoverage(record) };
}

export async function fetchSportmonksFixtureXg({ request, sportmonksApiKey, fixture }) {
  if (!sportmonksApiKey) {
    return xgProviderResult({
      status: XG_STATUS.NOT_CONFIGURED,
      source: SOURCE,
      records: [],
      meta: { reason: "NOT_CONFIGURED" }
    });
  }

  const externalFixtureId = fixture.externalFixtureId || fixture.sportmonksFixtureId;
  if (!externalFixtureId) {
    return xgProviderResult({
      status: XG_STATUS.NA,
      source: SOURCE,
      records: [],
      meta: { reason: "MISSING_EXTERNAL_FIXTURE_ID" }
    });
  }

  try {
    const url = new URL(`${BASE_URL}/fixtures/${externalFixtureId}`);
    url.searchParams.set("api_token", sportmonksApiKey);
    url.searchParams.set("include", "xGFixture");
    const payload = await request(url);
    const record = normalizeSportmonksFixture(payload, fixture);
    const status = record.coverage === "N/A" ? XG_STATUS.NOT_COVERED : XG_STATUS.OK;
    return xgProviderResult({
      status,
      source: SOURCE,
      records: status === XG_STATUS.OK ? [record] : [],
      meta: {
        coverage: record.coverage,
        externalFixtureId: String(externalFixtureId)
      }
    });
  } catch (error) {
    const status = classifyXgHttpError(error);
    return xgProviderResult({
      status,
      source: SOURCE,
      records: [],
      error: { code: status, message: error.message || String(error) },
      meta: { externalFixtureId: String(externalFixtureId) }
    });
  }
}
