import fs from "node:fs";
import path from "node:path";
import { providerResult, SourceStatus } from "../providerResult.js";
import { ODDS_API_IO_LEAGUE_SLUGS } from "../../config/competitions.js";
import { resolveRuntimeRoot } from "../../storage/runtime.js";

export const ODDS_API_IO_SOURCE = "ODDS_API_IO";

const BASE_URL = "https://api.odds-api.io/v3";
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

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9а-яё]/gi, "")
    .replace(/fc|cf|afc|club|calcio|football/g, "");
}

function similarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const chars = new Set(x);
  let common = 0;
  for (const c of y) if (chars.has(c)) common++;
  return common / Math.max(x.length, y.length, 1);
}

function kickoffScore(fixtureUtcDate, eventDate, toleranceMinutes) {
  const fixtureTime = new Date(fixtureUtcDate).getTime();
  const eventTime = new Date(eventDate).getTime();
  if (!Number.isFinite(fixtureTime) || !Number.isFinite(eventTime)) return 0;
  const diffMinutes = Math.abs(fixtureTime - eventTime) / 60_000;
  if (diffMinutes > toleranceMinutes) return 0;
  return Math.max(0, 1 - diffMinutes / toleranceMinutes);
}

function leagueScore(fixture, event) {
  const expected = ODDS_API_IO_LEAGUE_SLUGS[fixture.competitionCode];
  const actual = event.league?.slug || event.league_slug || "";
  if (!expected || !actual) return 0.7;
  return expected === actual ? 1 : 0.4;
}

export function matchOddsApiIoEvent(fixture, events, {
  minConfidence = 0.7,
  kickoffToleranceMinutes = 180
} = {}) {
  const candidates = (events || [])
    .map(event => {
      const home = similarity(fixture.home, event.home);
      const away = similarity(fixture.away, event.away);
      const kickoff = kickoffScore(fixture.utcDate, event.date, kickoffToleranceMinutes);
      const league = leagueScore(fixture, event);
      const confidence = Number(((home * 0.35) + (away * 0.35) + (kickoff * 0.2) + (league * 0.1)).toFixed(4));
      return { event, confidence, components: { home, away, kickoff, league } };
    })
    .filter(candidate => candidate.components.home >= 0.6 && candidate.components.away >= 0.6 && candidate.components.kickoff > 0)
    .sort((a, b) => b.confidence - a.confidence);

  const best = candidates[0] || null;
  if (!best || best.confidence < minConfidence) {
    return {
      event: null,
      confidence: best?.confidence || 0,
      diagnostic: best ? "MATCH_LOW_CONFIDENCE" : "MATCH_NOT_FOUND",
      components: best?.components || null
    };
  }
  return { ...best, diagnostic: null };
}

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function classifyHttpError(error) {
  const message = error.message || "";
  if (message.startsWith("400") && message.toLowerCase().includes("valid bookmaker")) return SourceStatus.NA;
  if (message.startsWith("403") && message.toLowerCase().includes("allowed max") && message.toLowerCase().includes("bookmakers")) {
    return SourceStatus.NA;
  }
  if (message.startsWith("429") || message.toLowerCase().includes("rate") || message.toLowerCase().includes("quota")) {
    return SourceStatus.QUOTA;
  }
  if (message.startsWith("401") || message.startsWith("403")) return SourceStatus.ERROR;
  if (message.toLowerCase().includes("timeout")) return SourceStatus.ERROR;
  return SourceStatus.ERROR;
}

function providerErrorCode(error, status) {
  const message = error.message || "";
  if (status === SourceStatus.QUOTA) return "QUOTA";
  if (message.startsWith("400") && message.toLowerCase().includes("valid bookmaker")) return "BOOKMAKER_INVALID";
  if (message.startsWith("403") && message.toLowerCase().includes("allowed max") && message.toLowerCase().includes("bookmakers")) {
    return "BOOKMAKER_SELECTION_MISMATCH";
  }
  if (message.startsWith("401") || message.startsWith("403")) return "UNAUTHORIZED";
  return status;
}

function marketKey(name = "") {
  const normalized = String(name).toLowerCase();
  if (["ml", "moneyline", "moneyline_3way", "match winner", "1x2", "h2h"].includes(normalized)) return "h2h";
  if (normalized === "spread" || normalized.includes("handicap")) return "spreads";
  if (normalized === "totals" || normalized === "goals over/under" || normalized === "over/under") return "totals";
  return null;
}

function h2hOutcomes(market, home, away) {
  const rows = market.outcomes || market.odds || [];
  const outcomes = [];
  for (const row of rows) {
    if (Number.isFinite(Number(row.home))) outcomes.push({ name: home, price: Number(row.home) });
    if (Number.isFinite(Number(row.draw))) outcomes.push({ name: "Draw", price: Number(row.draw) });
    if (Number.isFinite(Number(row.away))) outcomes.push({ name: away, price: Number(row.away) });
    const label = String(row.name || row.selection || row.side || "").toLowerCase();
    const price = Number(row.price ?? row.odds_decimal ?? row.decimal ?? row.odd);
    if (!Number.isFinite(price)) continue;
    if (["home", "1"].includes(label) || label === home.toLowerCase()) outcomes.push({ name: home, price });
    if (["draw", "x"].includes(label)) outcomes.push({ name: "Draw", price });
    if (["away", "2"].includes(label) || label === away.toLowerCase()) outcomes.push({ name: away, price });
  }
  const unique = new Map(outcomes.map(outcome => [outcome.name, outcome]));
  return [...unique.values()];
}

function lineOutcomes(market, home, away) {
  return (market.outcomes || market.odds || []).flatMap(row => {
    const line = row.line ?? row.hdp ?? row.handicap ?? null;
    const rows = [];
    if (Number.isFinite(Number(row.home))) rows.push({ name: home, price: Number(row.home), line });
    if (Number.isFinite(Number(row.away))) rows.push({ name: away, price: Number(row.away), line });
    if (Number.isFinite(Number(row.over))) rows.push({ name: "Over", price: Number(row.over), line });
    if (Number.isFinite(Number(row.under))) rows.push({ name: "Under", price: Number(row.under), line });
    const label = String(row.name || row.selection || row.side || row.bookmakerOutcomeId || "");
    const price = Number(row.price ?? row.odds_decimal ?? row.decimal ?? row.odd);
    if (label && Number.isFinite(price)) rows.push({ name: label, price, line });
    return rows;
  });
}

function normalizeBookmakers(bookmakers, home, away) {
  const entries = Array.isArray(bookmakers)
    ? bookmakers.map(book => [book.title || book.name || book.bookmaker, book.markets || book.bets || []])
    : Object.entries(bookmakers || {});

  return entries.map(([title, rawMarkets]) => {
    const markets = [];
    for (const rawMarket of rawMarkets || []) {
      const key = marketKey(rawMarket.key || rawMarket.name || rawMarket.market || rawMarket.market_type);
      if (!key) continue;
      const outcomes = key === "h2h" ? h2hOutcomes(rawMarket, home, away) : lineOutcomes(rawMarket, home, away);
      if (key === "h2h" && outcomes.length === 3) markets.push({ key, outcomes });
      if (key !== "h2h" && outcomes.length) markets.push({ key, outcomes });
    }
    return { title, markets };
  }).filter(book => book.title && book.markets.length);
}

function normalizeOddsEvent(row) {
  const home = row.home || row.home_team || "Home";
  const away = row.away || row.away_team || "Away";
  return {
    id: String(row.id || row.eventId || ""),
    externalEventId: String(row.id || row.eventId || ""),
    sport_key: "football",
    commence_time: row.date || row.commence_time || row.start_time || null,
    competition: row.league?.name || row.competition || row.leagueName || null,
    league: row.league || null,
    home_team: home,
    away_team: away,
    observedAt: row.updatedAt || row.updated_at || new Date().toISOString(),
    source: ODDS_API_IO_SOURCE,
    bookmakers: normalizeBookmakers(row.bookmakers, home, away),
    providerMeta: {
      provider: ODDS_API_IO_SOURCE,
      externalEventId: String(row.id || row.eventId || "")
    }
  };
}

async function cachedRequest({ cacheFile, now, cacheMinutes, fetcher }) {
  const cached = readJson(cacheFile);
  if (cacheFresh(cached, now, cacheMinutes)) return { payload: cached.data, cacheHit: true };
  const payload = await fetcher();
  writeJson(cacheFile, {
    fetchedAt: new Date(now).toISOString(),
    provider: ODDS_API_IO_SOURCE,
    data: payload
  });
  return { payload, cacheHit: false };
}

export async function oddsProviderOddsApiIo({
  request,
  oddsApiIoKey,
  oddsApiIoBookmakers = "",
  fixtures = [],
  root,
  runtimeRoot,
  now = new Date(),
  cacheMinutes = 10,
  kickoffToleranceMinutes = 180,
  minConfidence = 0.7
} = {}) {
  if (!oddsApiIoKey) {
    const result = providerResult({
      status: SourceStatus.NA,
      source: "odds-api-io",
      data: [],
      meta: { provider: ODDS_API_IO_SOURCE, reason: "NOT_CONFIGURED" }
    });
    return { ...result, events: [], requestsUsed: 0 };
  }

  const supportedFixtures = fixtures.filter(fixture => ODDS_API_IO_LEAGUE_SLUGS[fixture.competitionCode]);
  if (!supportedFixtures.length) {
    const result = providerResult({
      status: SourceStatus.NA,
      source: "odds-api-io",
      data: [],
      meta: { provider: ODDS_API_IO_SOURCE, reason: "NO_SUPPORTED_FIXTURES" }
    });
    return { ...result, events: [], requestsUsed: 0 };
  }

  const rawDir = path.join(resolveRuntimeRoot(root, runtimeRoot), "market", "odds-api-io-raw");
  const eventsByLeague = new Map();
  for (const fixture of supportedFixtures) {
    const slug = ODDS_API_IO_LEAGUE_SLUGS[fixture.competitionCode];
    if (!eventsByLeague.has(slug)) eventsByLeague.set(slug, []);
    eventsByLeague.get(slug).push(fixture);
  }

  const fetchedEvents = [];
  const errors = [];
  let requestsUsed = 0;
  let eventRequests = 0;
  let oddsBatchRequests = 0;
  let cacheHits = 0;

  for (const [leagueSlug, leagueFixtures] of eventsByLeague.entries()) {
    const times = leagueFixtures.map(fixture => new Date(fixture.utcDate).getTime()).filter(Number.isFinite);
    const from = new Date(Math.min(...times) - kickoffToleranceMinutes * 60_000).toISOString();
    const to = new Date(Math.max(...times) + kickoffToleranceMinutes * 60_000).toISOString();
    const cacheFile = path.join(rawDir, `events-${leagueSlug}-${from.slice(0, 10)}-${to.slice(0, 10)}.json`);
    try {
      const { payload, cacheHit } = await cachedRequest({
        cacheFile,
        now,
        cacheMinutes,
        fetcher: async () => {
          const url = new URL(`${BASE_URL}/events`);
          url.searchParams.set("apiKey", oddsApiIoKey);
          url.searchParams.set("sport", "football");
          url.searchParams.set("league", leagueSlug);
          url.searchParams.set("status", "pending");
          url.searchParams.set("from", from);
          url.searchParams.set("to", to);
          requestsUsed += 1;
          eventRequests += 1;
          const data = await request(url);
          return data;
        }
      });
      if (cacheHit) cacheHits += 1;
      fetchedEvents.push(...(Array.isArray(payload) ? payload : []));
    } catch (error) {
      const status = classifyHttpError(error);
      errors.push({
        endpoint: "events",
        league: leagueSlug,
        status,
        reason: providerErrorCode(error, status),
        message: error.message
      });
    }
  }

  const matches = supportedFixtures.map(fixture => ({
    fixture,
    match: matchOddsApiIoEvent(fixture, fetchedEvents, { minConfidence, kickoffToleranceMinutes })
  }));
  const matched = matches.filter(row => row.match.event);
  const rejected = matches.filter(row => !row.match.event);
  const eventIds = [...new Set(matched.map(row => String(row.match.event.id)))];
  const oddsRows = [];
  const bookmakerParam = String(oddsApiIoBookmakers || "").trim();

  if (!bookmakerParam) {
    const result = providerResult({
      status: SourceStatus.NA,
      source: "odds-api-io",
      data: [],
      meta: {
        provider: ODDS_API_IO_SOURCE,
        reason: "BOOKMAKERS_NOT_CONFIGURED",
        requestsUsed,
        eventRequests,
        oddsBatchRequests,
        cacheHits,
        eventsReceived: fetchedEvents.length,
        matchedFixtures: matched.length,
        rejectedFixtures: rejected.length,
        coveragePercent: supportedFixtures.length ? (matched.length / supportedFixtures.length) * 100 : 0,
        bookmakersConfigured: 0,
        matchReports: matches.map(row => ({
          fixtureId: row.fixture.id,
          externalEventId: row.match.event?.id ? String(row.match.event.id) : null,
          confidence: row.match.confidence,
          diagnostic: row.match.diagnostic,
          components: row.match.components
        })),
        errors
      },
      error: {
        code: "BOOKMAKERS_NOT_CONFIGURED",
        message: "ODDS_API_IO_BOOKMAKERS is required by odds-api.io odds endpoints"
      }
    });
    return { ...result, events: [], requestsUsed };
  }

  for (const ids of chunk(eventIds, 10)) {
    const cacheFile = path.join(rawDir, `odds-${ids.join("-")}.json`);
    try {
      const { payload, cacheHit } = await cachedRequest({
        cacheFile,
        now,
        cacheMinutes,
        fetcher: async () => {
          const url = new URL(`${BASE_URL}/odds/multi`);
          url.searchParams.set("apiKey", oddsApiIoKey);
          url.searchParams.set("eventIds", ids.join(","));
          if (bookmakerParam) url.searchParams.set("bookmakers", bookmakerParam);
          requestsUsed += 1;
          oddsBatchRequests += 1;
          const data = await request(url);
          return data;
        }
      });
      if (cacheHit) cacheHits += 1;
      oddsRows.push(...(Array.isArray(payload) ? payload : []));
    } catch (error) {
      const status = classifyHttpError(error);
      errors.push({
        endpoint: "odds/multi",
        eventIds: ids,
        status,
        reason: providerErrorCode(error, status),
        message: error.message
      });
    }
  }

  const events = oddsRows.map(normalizeOddsEvent).filter(event => event.bookmakers.length);
  const hardStatus = errors.find(error => [SourceStatus.QUOTA, SourceStatus.ERROR].includes(error.status))?.status;
  const status = hardStatus && !events.length
    ? hardStatus
    : errors.length
      ? events.length ? SourceStatus.PARTIAL : errors[0].status
      : events.length
        ? SourceStatus.OK
        : SourceStatus.NA;
  const result = providerResult({
    status,
    source: "odds-api-io",
    data: events,
    error: errors.length ? { code: errors[0].reason || hardStatus || "PARTIAL", message: `${errors.length} odds-api.io request(s) failed` } : null,
    meta: {
      provider: ODDS_API_IO_SOURCE,
      reason: errors[0]?.reason || (!events.length ? "NO_ODDS" : null),
      requestsUsed,
      eventRequests,
      oddsBatchRequests,
      cacheHits,
      eventsReceived: fetchedEvents.length,
      matchedFixtures: matched.length,
      rejectedFixtures: rejected.length,
      coveragePercent: supportedFixtures.length ? (matched.length / supportedFixtures.length) * 100 : 0,
      bookmakersConfigured: bookmakerParam ? bookmakerParam.split(",").map(v => v.trim()).filter(Boolean).length : 0,
      matchReports: matches.map(row => ({
        fixtureId: row.fixture.id,
        externalEventId: row.match.event?.id ? String(row.match.event.id) : null,
        confidence: row.match.confidence,
        diagnostic: row.match.diagnostic,
        components: row.match.components
      })),
      errors
    }
  });

  return { ...result, events, requestsUsed };
}
