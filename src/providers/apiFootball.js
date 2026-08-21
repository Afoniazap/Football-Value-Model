import fs from "node:fs";
import path from "node:path";
import { providerResult, SourceStatus } from "./providerResult.js";
import { resolveRuntimeRoot } from "../storage/runtime.js";

const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";

function apiFootballSource(fixture) {
  return `api-football.${fixture.id}`;
}

function fixtureDate(fixture) {
  return new Date(fixture.utcDate).toISOString().slice(0, 10);
}

function stableParams(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function cacheFresh(payload, now, ttlMinutes) {
  if (!payload?.fetchedAt) return false;
  const ageMinutes = (new Date(now).getTime() - new Date(payload.fetchedAt).getTime()) / 60_000;
  return Number.isFinite(ageMinutes) && ageMinutes <= ttlMinutes;
}

function mappingValid(mapping, fixture) {
  return mapping &&
    String(mapping.fixtureId) === String(fixture.id) &&
    mapping.kickoff === fixture.utcDate &&
    mapping.teams?.home === fixture.home &&
    mapping.teams?.away === fixture.away &&
    Number(mapping.matchConfidence) >= 0.72;
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
  if (errorOrPayload?.status === SourceStatus.QUOTA || errorOrPayload?.code === "QUOTA_BACKOFF") {
    return { status: SourceStatus.QUOTA, code: errorOrPayload.code || "QUOTA", message: errorOrPayload.message || "API-Football quota unavailable" };
  }
  const message = errorOrPayload?.message || errorText(errorOrPayload) || "";
  const lower = message.toLowerCase();

  if (message.includes("Free plans do not have access to this date")) {
    return {
      status: SourceStatus.NA,
      code: "PLAN_DATE_WINDOW",
      message
    };
  }
  if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("request limit") || lower.includes("limit for the day")) {
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

export function createApiFootballIntelCache(root, {
  now = new Date(),
  ttlMinutes = 30,
  runtimeRoot = resolveRuntimeRoot(root),
  injuriesCacheHours = 6,
  lineupsEarlyCacheHours = 6,
  lineupsPrematchMinutes = 90,
  lineupsPrematchCacheMinutes = 15
} = {}) {
  const dir = path.join(runtimeRoot, "api-football");
  const mappingFile = path.join(dir, "fixture-mapping.json");
  const quotaBackoffFile = path.join(dir, "quota-backoff.json");
  const memory = new Map();
  const counters = {
    requestsUsed: 0,
    cacheHits: 0,
    mappingHits: 0,
    injuriesFetches: 0,
    lineupsFetches: 0,
    lineupsSkippedEarly: 0,
    quotaBackoffHits: 0
  };

  function rawFile(endpoint, params) {
    const safe = `${endpoint}-${stableParams(params)}`.replaceAll(/[^a-zA-Z0-9_.=-]+/g, "_");
    return path.join(dir, "raw", `${safe}.json`);
  }

  function readMappings() {
    return readJson(mappingFile) || {};
  }

  function readBackoff() {
    return readJson(quotaBackoffFile) || {};
  }

  function writeBackoff(row) {
    const backoff = readBackoff();
    backoff.apiFootball = row;
    writeJson(quotaBackoffFile, backoff);
  }

  function backoffUntilNextUtcDay(reason = "QUOTA") {
    const current = new Date(now);
    const until = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 0, 5, 0));
    writeBackoff({ status: SourceStatus.QUOTA, reason, until: until.toISOString(), setAt: new Date(now).toISOString() });
    return until.toISOString();
  }

  function currentBackoff() {
    const row = readBackoff().apiFootball;
    if (!row?.until) return null;
    if (new Date(row.until).getTime() <= new Date(now).getTime()) return null;
    return row;
  }

  function ttlFor(endpoint, fixture = null) {
    if (endpoint === "injuries") return injuriesCacheHours * 60;
    if (endpoint === "fixtures/lineups") {
      const kickoffMs = fixture ? new Date(fixture.utcDate).getTime() : NaN;
      const minutesToKickoff = (kickoffMs - new Date(now).getTime()) / 60_000;
      return Number.isFinite(minutesToKickoff) && minutesToKickoff <= lineupsPrematchMinutes
        ? lineupsPrematchCacheMinutes
        : lineupsEarlyCacheHours * 60;
    }
    return ttlMinutes;
  }

  function readEndpointCache(endpoint, params, ttlMinutesOverride = null) {
    const key = `${endpoint}?${stableParams(params)}`;
    if (memory.has(key)) {
      counters.cacheHits += 1;
      return { data: memory.get(key), hit: true, source: "memory" };
    }
    const file = rawFile(endpoint, params);
    const cached = readJson(file);
    const ttl = ttlMinutesOverride ?? ttlMinutes;
    if (cacheFresh(cached, now, ttl)) {
      counters.cacheHits += 1;
      memory.set(key, cached.data);
      return { data: cached.data, hit: true, source: "disk", fetchedAt: cached.fetchedAt };
    }
    return { data: cached?.data || null, hit: false, source: cached ? "expired" : "miss", fetchedAt: cached?.fetchedAt || null };
  }

  function cachedConfirmedLineups(endpoint, params, fixture) {
    const cached = readEndpointCache(endpoint, params, 365 * 24 * 60);
    const lineups = cached.data?.response || [];
    const beforeKickoff = new Date(now).getTime() < new Date(fixture.utcDate).getTime();
    if (cached.data && beforeKickoff && lineups.length >= 2) return cached;
    return null;
  }

  function shouldSkipEarlyLineups(fixture) {
    const kickoffMs = new Date(fixture.utcDate).getTime();
    const minutesToKickoff = (kickoffMs - new Date(now).getTime()) / 60_000;
    return Number.isFinite(minutesToKickoff) && minutesToKickoff > lineupsPrematchMinutes;
  }

  function getMapping(fixture) {
    const mapping = readMappings()[fixture.id];
    if (!mappingValid(mapping, fixture)) return null;
    counters.mappingHits += 1;
    return mapping;
  }

  function setMapping(fixture, match) {
    if (!match || match.confidence < 0.72) return null;
    const mappings = readMappings();
    const row = {
      fixtureId: String(fixture.id),
      provider: "API_FOOTBALL",
      externalFixtureId: String(match.fixture.fixture?.id),
      matchConfidence: match.confidence,
      kickoff: fixture.utcDate,
      teams: { home: fixture.home, away: fixture.away },
      resolvedAt: new Date(now).toISOString()
    };
    mappings[fixture.id] = row;
    writeJson(mappingFile, mappings);
    return row;
  }

  async function getOrFetch({ request, apiFootballKey, endpoint, params, fixture = null }) {
    const key = `${endpoint}?${stableParams(params)}`;
    const ttl = ttlFor(endpoint, fixture);
    const cached = readEndpointCache(endpoint, params, ttl);
    if (cached.hit) return cached.data;

    const backoff = currentBackoff();
    if (backoff) {
      counters.quotaBackoffHits += 1;
      const error = new Error(`API-Football quota backoff active until ${backoff.until}`);
      error.code = "QUOTA_BACKOFF";
      error.status = SourceStatus.QUOTA;
      throw error;
    }

    try {
      const payload = await apiFootballRequest(request, apiFootballKey, endpoint, params, null);
      counters.requestsUsed += 1;
      if (endpoint === "injuries") counters.injuriesFetches += 1;
      if (endpoint === "fixtures/lineups") counters.lineupsFetches += 1;
      writeJson(rawFile(endpoint, params), {
        fetchedAt: new Date(now).toISOString(),
        endpoint,
        params,
        data: payload
      });
      memory.set(key, payload);
      return payload;
    } catch (error) {
      const classified = classifyApiFootballError(error);
      if (classified.status === SourceStatus.QUOTA) backoffUntilNextUtcDay(classified.code);
      throw error;
    }
  }

  return {
    dir,
    mappingFile,
    quotaBackoffFile,
    counters,
    options: { injuriesCacheHours, lineupsEarlyCacheHours, lineupsPrematchMinutes, lineupsPrematchCacheMinutes },
    getMapping,
    setMapping,
    getOrFetch,
    readEndpointCache,
    cachedConfirmedLineups,
    shouldSkipEarlyLineups,
    currentBackoff
  };
}
async function apiFootballRequest(request, apiFootballKey, endpoint, params = {}, intelCache = null, fixture = null) {
  if (intelCache) {
    return intelCache.getOrFetch({ request, apiFootballKey, endpoint, params, fixture });
  }
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

export async function fetchApiFootballFixtureIntel({ request, apiFootballKey, fixture, intelCache = null }) {
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
    let match = null;
    const cachedMapping = intelCache?.getMapping(fixture);
    if (cachedMapping) {
      match = {
        fixture: { fixture: { id: Number(cachedMapping.externalFixtureId) } },
        confidence: cachedMapping.matchConfidence,
        components: { cached: true }
      };
    } else {
      const fixturesPayload = await apiFootballRequest(request, apiFootballKey, "fixtures", {
        date: fixtureDate(fixture),
        timezone: "UTC"
      }, intelCache);
      match = matchFixture(fixture, fixturesPayload.response || []);
      if (match) intelCache?.setMapping(fixture, match);
    }

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
      }, intelCache);
      injuries = injuriesPayload.response || [];
      endpointResults.push({
        endpoint: "injuries",
        status: SourceStatus.OK,
        count: injuries.length,
        source: "CACHE_OR_FETCH"
      });
    } catch (error) {
      const classified = classifyApiFootballError(error);
      endpointResults.push({
        endpoint: "injuries",
        status: classified.status,
        reason: classified.code,
        message: classified.message
      });
    }

    const lineupParams = { fixture: apiFixtureId };
    const confirmedLineups = intelCache?.cachedConfirmedLineups("fixtures/lineups", lineupParams, fixture);
    const shouldSkipLineups = intelCache?.shouldSkipEarlyLineups(fixture);

    if (confirmedLineups) {
      lineups = confirmedLineups.data.response || [];
      endpointResults.push({
        endpoint: "lineups",
        status: SourceStatus.OK,
        count: lineups.length,
        note: "PUBLISHED",
        source: "CONFIRMED_CACHE"
      });
    } else if (shouldSkipLineups) {
      const cachedLineups = intelCache?.readEndpointCache("fixtures/lineups", lineupParams, intelCache.options.lineupsEarlyCacheHours * 60);
      lineups = cachedLineups?.data?.response || [];
      intelCache.counters.lineupsSkippedEarly += 1;
      endpointResults.push({
        endpoint: "lineups",
        status: cachedLineups?.hit ? SourceStatus.OK : SourceStatus.NA,
        count: lineups.length,
        reason: cachedLineups?.hit ? null : "EARLY_PREMATCH",
        note: lineups.length ? "PUBLISHED" : "NOT_PUBLISHED",
        skipped: !cachedLineups?.hit,
        source: cachedLineups?.hit ? "CACHE" : "EARLY_SKIP"
      });
    } else {
      try {
        const lineupsPayload = await apiFootballRequest(request, apiFootballKey, "fixtures/lineups", lineupParams, intelCache, fixture);
        lineups = lineupsPayload.response || [];
        endpointResults.push({
          endpoint: "lineups",
          status: SourceStatus.OK,
          count: lineups.length,
          note: lineups.length ? "PUBLISHED" : "NOT_PUBLISHED",
          source: "CACHE_OR_FETCH"
        });
      } catch (error) {
        const classified = classifyApiFootballError(error);
        endpointResults.push({
          endpoint: "lineups",
          status: classified.status,
          reason: classified.code,
          message: classified.message
        });
      }
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
        endpoints: endpointResults,
        requestsUsed: intelCache?.counters.requestsUsed || null,
        cacheHits: intelCache?.counters.cacheHits || 0,
        mappingHits: intelCache?.counters.mappingHits || 0,
        injuriesFetches: intelCache?.counters.injuriesFetches || 0,
        lineupsFetches: intelCache?.counters.lineupsFetches || 0,
        lineupsSkippedEarly: intelCache?.counters.lineupsSkippedEarly || 0,
        quotaBackoffHits: intelCache?.counters.quotaBackoffHits || 0,
        quotaBackoffUntil: intelCache?.currentBackoff()?.until || null
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
      meta: {
        date: fixtureDate(fixture),
        requestsUsed: intelCache?.counters.requestsUsed || null,
        cacheHits: intelCache?.counters.cacheHits || 0,
        mappingHits: intelCache?.counters.mappingHits || 0,
        injuriesFetches: intelCache?.counters.injuriesFetches || 0,
        lineupsFetches: intelCache?.counters.lineupsFetches || 0,
        lineupsSkippedEarly: intelCache?.counters.lineupsSkippedEarly || 0,
        quotaBackoffHits: intelCache?.counters.quotaBackoffHits || 0,
        quotaBackoffUntil: intelCache?.currentBackoff()?.until || null
      }
    });
  }
}
