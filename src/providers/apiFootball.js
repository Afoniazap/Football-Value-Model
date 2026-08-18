import { providerResult, SourceStatus } from "./providerResult.js";

const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";

function apiFootballSource(fixture) {
  return `api-football.${fixture.id}`;
}

function fixtureDate(fixture) {
  return new Date(fixture.utcDate).toISOString().slice(0, 10);
}

function hasApiErrors(payload) {
  if (!payload?.errors) return false;
  if (Array.isArray(payload.errors)) return payload.errors.length > 0;
  return Object.keys(payload.errors).length > 0;
}

function errorText(payload) {
  if (!payload?.errors) return "";
  if (Array.isArray(payload.errors)) return payload.errors.join(" ");
  return Object.values(payload.errors).join(" ");
}

function classifyApiFootballError(errorOrPayload) {
  const message = errorOrPayload?.message || errorText(errorOrPayload) || "";
  const lower = message.toLowerCase();

  if (message.includes("Free plans do not have access to this date")) {
    return {
      status: SourceStatus.NA,
      code: "PLAN_DATE_WINDOW",
      message
    };
  }
  if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      status: SourceStatus.QUOTA,
      code: "QUOTA",
      message
    };
  }
  if (message.startsWith("401") || message.startsWith("403") || lower.includes("not allowed")) {
    return {
      status: SourceStatus.ERROR,
      code: "UNAUTHORIZED",
      message
    };
  }
  if (lower.includes("timeout")) {
    return {
      status: SourceStatus.ERROR,
      code: "TIMEOUT",
      message
    };
  }
  return {
    status: SourceStatus.ERROR,
    code: "ERROR",
    message
  };
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9а-яё]/gi, "")
    .replace(/fc|cf|afc|club|calcio|football/g, "");
}

function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const chars = new Set(x);
  let common = 0;
  for (const c of y) if (chars.has(c)) common++;
  return common / Math.max(x.length, y.length, 1);
}

function kickoffScore(fixtureUtcDate, apiFixture) {
  const fixtureTime = new Date(fixtureUtcDate).getTime();
  const apiTime = Number(apiFixture?.fixture?.timestamp) * 1000 ||
    new Date(apiFixture?.fixture?.date).getTime();
  if (!Number.isFinite(fixtureTime) || !Number.isFinite(apiTime)) return 0;
  const diffHours = Math.abs(fixtureTime - apiTime) / 3600_000;
  if (diffHours <= 0.25) return 1;
  if (diffHours <= 1) return 0.85;
  if (diffHours <= 3) return 0.6;
  return 0;
}

function matchFixture(fixture, candidates) {
  let best = null;
  for (const candidate of candidates || []) {
    const home = similarity(fixture.home, candidate.teams?.home?.name);
    const away = similarity(fixture.away, candidate.teams?.away?.name);
    const kickoff = kickoffScore(fixture.utcDate, candidate);
    const confidence = home * 0.4 + away * 0.4 + kickoff * 0.2;
    if (!best || confidence > best.confidence) {
      best = { fixture: candidate, confidence, components: { home, away, kickoff } };
    }
  }
  if (!best || best.confidence < 0.72 || best.components.kickoff === 0) return null;
  return best;
}

async function apiFootballRequest(request, apiFootballKey, endpoint, params = {}) {
  const url = new URL(`${API_FOOTBALL_BASE_URL}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const payload = await request(url, {
    headers: { "x-apisports-key": apiFootballKey }
  });

  if (hasApiErrors(payload)) {
    const classified = classifyApiFootballError(payload);
    const error = new Error(classified.message);
    error.code = classified.code;
    error.status = classified.status;
    throw error;
  }

  return payload;
}

export async function fetchApiFootballFixtureIntel({ request, apiFootballKey, fixture }) {
  const source = apiFootballSource(fixture);

  if (!apiFootballKey) {
    return providerResult({
      status: SourceStatus.NA,
      source,
      data: {
        apiFixture: null,
        injuries: [],
        lineups: [],
        absences: []
      },
      meta: { reason: "NOT_CONNECTED" }
    });
  }

  try {
    const fixturesPayload = await apiFootballRequest(request, apiFootballKey, "fixtures", {
      date: fixtureDate(fixture),
      timezone: "UTC"
    });
    const match = matchFixture(fixture, fixturesPayload.response || []);

    if (!match) {
      return providerResult({
        status: SourceStatus.NA,
        source,
        data: {
          apiFixture: null,
          injuries: [],
          lineups: [],
          absences: []
        },
        meta: {
          reason: "FIXTURE_NOT_FOUND",
          date: fixtureDate(fixture),
          candidates: fixturesPayload.results || 0
        }
      });
    }

    const apiFixtureId = match.fixture.fixture?.id;
    const endpointResults = [];
    let injuries = [];
    let lineups = [];

    try {
      const injuriesPayload = await apiFootballRequest(request, apiFootballKey, "injuries", {
        fixture: apiFixtureId
      });
      injuries = injuriesPayload.response || [];
      endpointResults.push({ endpoint: "injuries", status: SourceStatus.OK, count: injuries.length });
    } catch (error) {
      const classified = classifyApiFootballError(error);
      endpointResults.push({
        endpoint: "injuries",
        status: classified.status,
        reason: classified.code,
        message: classified.message
      });
    }

    try {
      const lineupsPayload = await apiFootballRequest(request, apiFootballKey, "fixtures/lineups", {
        fixture: apiFixtureId
      });
      lineups = lineupsPayload.response || [];
      endpointResults.push({ endpoint: "lineups", status: SourceStatus.OK, count: lineups.length });
    } catch (error) {
      const classified = classifyApiFootballError(error);
      endpointResults.push({
        endpoint: "lineups",
        status: classified.status,
        reason: classified.code,
        message: classified.message
      });
    }

    const hardFailure = endpointResults.find(result =>
      [SourceStatus.QUOTA, SourceStatus.ERROR].includes(result.status)
    );
    const partial = endpointResults.some(result => result.status !== SourceStatus.OK);

    return providerResult({
      status: hardFailure?.status || (partial ? SourceStatus.PARTIAL : SourceStatus.OK),
      source,
      data: {
        apiFixture: match.fixture,
        injuries,
        lineups,
        absences: injuries
      },
      error: hardFailure
        ? { code: hardFailure.reason || hardFailure.status, message: hardFailure.message || hardFailure.status }
        : null,
      meta: {
        apiFixtureId,
        matchConfidence: match.confidence,
        matchComponents: match.components,
        endpoints: endpointResults
      }
    });
  } catch (error) {
    const classified = classifyApiFootballError(error);
    return providerResult({
      status: classified.status,
      source,
      data: {
        apiFixture: null,
        injuries: [],
        lineups: [],
        absences: []
      },
      error: {
        code: classified.code,
        message: classified.message
      },
      meta: { date: fixtureDate(fixture) }
    });
  }
}
