import fs from "node:fs";
import path from "node:path";
import { providerResult, SourceStatus } from "../providerResult.js";
import { API_FOOTBALL_LEAGUE_IDS } from "../../config/competitions.js";

export const API_FOOTBALL_SOURCE = "API_FOOTBALL";

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function seasonFromKickoff(value) {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month >= 7 ? year : year - 1;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function cacheFresh(payload, now, cacheMinutes) {
  if (!payload?.fetchedAt) return false;
  const ageMinutes = (new Date(now).getTime() - new Date(payload.fetchedAt).getTime()) / 60_000;
  return Number.isFinite(ageMinutes) && ageMinutes <= cacheMinutes;
}

function classifySecondaryError(error) {
  const message = error.message || "";
  if (message.includes("429") || message.toLowerCase().includes("rate") || message.toLowerCase().includes("quota")) {
    return SourceStatus.QUOTA;
  }
  if (message.includes("No API_FOOTBALL_KEY") || message.toLowerCase().includes("free plan")) return SourceStatus.NA;
  return SourceStatus.ERROR;
}

function classifyApiFootballOddsError(errors) {
  const text = errors.map(error => error.message).join(" ").toLowerCase();
  if (text.includes("free plans do not have access to this season")) {
    return {
      status: SourceStatus.NA,
      code: "PLAN_SEASON_WINDOW"
    };
  }
  if (errors.some(error => error.code === "requests") || text.includes("quota") || text.includes("rate")) {
    return {
      status: SourceStatus.QUOTA,
      code: "QUOTA"
    };
  }
  return {
    status: SourceStatus.NA,
    code: "API_ODDS_UNAVAILABLE"
  };
}

function apiErrors(payload) {
  const errors = payload?.errors;
  if (!errors || Array.isArray(errors) && errors.length === 0) return [];
  if (typeof errors === "string") return errors ? [{ code: "api", message: errors }] : [];
  if (Array.isArray(errors)) {
    return errors.map((message, index) => ({ code: String(index), message: String(message) }));
  }
  return Object.entries(errors)
    .filter(([, message]) => String(message || "").trim())
    .map(([code, message]) => ({ code, message: String(message) }));
}

function betKey(name = "") {
  const normalized = String(name).toLowerCase();
  if (normalized.includes("match winner") || normalized === "1x2") return "h2h";
  if (normalized.includes("goals over/under") || normalized.includes("over/under")) return "totals";
  if (normalized.includes("asian handicap")) return "spreads";
  return null;
}

function normalizeH2hValues(values, home, away) {
  const outcomes = [];
  for (const value of values || []) {
    const label = String(value.value || "").toLowerCase();
    if (["home", "1"].includes(label)) outcomes.push({ name: home, price: Number(value.odd) });
    if (["draw", "x"].includes(label)) outcomes.push({ name: "Draw", price: Number(value.odd) });
    if (["away", "2"].includes(label)) outcomes.push({ name: away, price: Number(value.odd) });
  }
  return outcomes.filter(row => Number.isFinite(row.price));
}

function normalizeProviderEvent(row) {
  const fixture = row.fixture || {};
  const league = row.league || {};
  const teams = row.teams || {};
  const home = teams.home?.name || row.home_team || "Home";
  const away = teams.away?.name || row.away_team || "Away";
  const bookmakers = [];

  for (const bookmaker of row.bookmakers || []) {
    const markets = [];
    for (const bet of bookmaker.bets || []) {
      const key = betKey(bet.name);
      if (!key) continue;
      if (key === "h2h") {
        const outcomes = normalizeH2hValues(bet.values, home, away);
        if (outcomes.length === 3) markets.push({ key: "h2h", outcomes });
      }
      if (key === "totals") {
        const outcomes = (bet.values || []).map(value => ({
          name: String(value.value || ""),
          price: Number(value.odd)
        })).filter(value => Number.isFinite(value.price));
        if (outcomes.length) markets.push({ key: "totals", outcomes });
      }
      if (key === "spreads") {
        const outcomes = (bet.values || []).map(value => ({
          name: String(value.value || ""),
          price: Number(value.odd)
        })).filter(value => Number.isFinite(value.price));
        if (outcomes.length) markets.push({ key: "spreads", outcomes });
      }
    }
    if (markets.length) bookmakers.push({ title: bookmaker.name, markets });
  }

  return {
    id: String(fixture.id || row.fixture_id || ""),
    home_team: home,
    away_team: away,
    commence_time: fixture.date || row.update || null,
    competition: league.name || null,
    leagueId: league.id || null,
    observedAt: row.update || new Date().toISOString(),
    source: API_FOOTBALL_SOURCE,
    bookmakers
  };
}

function normalizeEvents(payload) {
  return (payload?.response || [])
    .map(normalizeProviderEvent)
    .filter(event => event.bookmakers.length);
}

function groupedFixtureRequests(fixtures) {
  const groups = new Map();
  for (const fixture of fixtures) {
    const league = API_FOOTBALL_LEAGUE_IDS[fixture.competitionCode];
    if (!league) continue;
    const date = dateOnly(fixture.utcDate);
    const season = seasonFromKickoff(fixture.utcDate);
    const key = `${league}-${season}-${date}`;
    if (!groups.has(key)) groups.set(key, { league, season, date, fixtures: [] });
    groups.get(key).fixtures.push(fixture);
  }
  return [...groups.values()];
}

export async function oddsProviderSecondary({
  request,
  apiFootballKey,
  fixtures = [],
  root,
  now = new Date(),
  cacheMinutes = 180
} = {}) {
  const fetchedAt = new Date(now).toISOString();
  if (!apiFootballKey) {
    const result = providerResult({
      status: SourceStatus.NA,
      source: "odds.secondary",
      data: [],
      meta: { reason: "API_FOOTBALL_KEY is not configured", provider: API_FOOTBALL_SOURCE }
    });
    return { ...result, events: [], requestsUsed: 0 };
  }

  const rawDir = path.join(root, "data", "market", "api-football-raw");
  const groups = groupedFixtureRequests(fixtures);
  const events = [];
  const errors = [];
  let requestsUsed = 0;
  let cacheHits = 0;

  for (const group of groups) {
    const cacheFile = path.join(rawDir, `${group.league}-${group.season}-${group.date}.json`);
    let payload = readJson(cacheFile);
    if (cacheFresh(payload, now, cacheMinutes)) {
      cacheHits += 1;
    } else {
      const url = new URL("https://v3.football.api-sports.io/odds");
      url.searchParams.set("league", String(group.league));
      url.searchParams.set("season", String(group.season));
      url.searchParams.set("date", group.date);
      try {
        payload = await request(url, { headers: { "x-apisports-key": apiFootballKey } });
        requestsUsed += 1;
        writeJson(cacheFile, {
          fetchedAt,
          provider: API_FOOTBALL_SOURCE,
          league: group.league,
          season: group.season,
          date: group.date,
          data: payload
        });
      } catch (error) {
        errors.push({ league: group.league, season: group.season, date: group.date, message: error.message });
        continue;
      }
    }
    const data = payload.data || payload;
    const responseErrors = apiErrors(data);
    if (responseErrors.length) {
      const classified = classifyApiFootballOddsError(responseErrors);
      errors.push({
        league: group.league,
        season: group.season,
        date: group.date,
        status: classified.status,
        reason: classified.code,
        apiErrors: responseErrors,
        message: responseErrors.map(error => `${error.code}: ${error.message}`).join("; ")
      });
      continue;
    }
    events.push(...normalizeEvents(data));
  }

  const status = errors.length === groups.length && groups.length
    ? errors[0].status || classifySecondaryError(new Error(errors[0].message))
    : errors.length
      ? SourceStatus.PARTIAL
      : events.length
        ? SourceStatus.OK
        : SourceStatus.NA;

  const result = providerResult({
    status,
    source: "odds.secondary",
    data: events,
    error: errors.length ? { code: errors[0]?.reason || status, message: `${errors.length} API-Football odds request(s) failed` } : null,
    meta: {
      provider: API_FOOTBALL_SOURCE,
      reason: errors[0]?.reason || null,
      requestsUsed,
      cacheHits,
      requestGroups: groups.length,
      fixturesRequested: fixtures.length,
      fixturesReceived: events.length,
      errors
    }
  });

  return {
    ...result,
    events,
    requestsUsed
  };
}
