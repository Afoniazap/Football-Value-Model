import {
  classifyXgHttpError,
  normalizeXgRecord,
  numberOrNull,
  xgCoverage,
  xgProviderResult,
  XG_STATUS
} from "./xgProvider.js";

const SOURCE = "THESTATSAPI_XG";
const BASE_URL = "https://api.thestatsapi.com/api";

function valueAt(path, object) {
  return path.reduce((current, key) => current?.[key], object);
}

export function normalizeTheStatsApiMatchStats(payload, fixture = {}) {
  const data = payload?.data || payload || {};
  const xg = valueAt(["overview", "expected_goals", "all"], data) || data.xg || {};
  const npxg = data.np_expected_goals?.all || data.npxg || {};
  const record = normalizeXgRecord({
    fixtureId: fixture.id || fixture.fixtureId || data.match_id,
    externalFixtureId: data.match_id || fixture.externalFixtureId,
    kickoff: fixture.utcDate || data.utc_date || data.kickoff,
    competition: fixture.competition || data.competition || null,
    home: {
      xG: numberOrNull(xg.home ?? data.home?.xg),
      npxG: numberOrNull(npxg.home ?? data.home?.npxg),
      xGA: numberOrNull(xg.away ?? data.away?.xg)
    },
    away: {
      xG: numberOrNull(xg.away ?? data.away?.xg),
      npxG: numberOrNull(npxg.away ?? data.away?.npxg),
      xGA: numberOrNull(xg.home ?? data.home?.xg)
    },
    source: SOURCE,
    observedAt: new Date().toISOString(),
    status: XG_STATUS.OK,
    providerMeta: { matchId: data.match_id || null }
  });
  return { ...record, coverage: xgCoverage(record) };
}

export async function fetchTheStatsApiFixtureXg({ request, theStatsApiKey, fixture }) {
  if (!theStatsApiKey) {
    return xgProviderResult({
      status: XG_STATUS.NOT_CONFIGURED,
      source: SOURCE,
      records: [],
      meta: { reason: "NOT_CONFIGURED" }
    });
  }

  const externalFixtureId = fixture.externalFixtureId || fixture.theStatsApiMatchId;
  if (!externalFixtureId) {
    return xgProviderResult({
      status: XG_STATUS.NA,
      source: SOURCE,
      records: [],
      meta: { reason: "MISSING_EXTERNAL_FIXTURE_ID" }
    });
  }

  try {
    const payload = await request(`${BASE_URL}/football/matches/${externalFixtureId}/stats`, {
      headers: { Authorization: `Bearer ${theStatsApiKey}` }
    });
    const record = normalizeTheStatsApiMatchStats(payload, fixture);
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
