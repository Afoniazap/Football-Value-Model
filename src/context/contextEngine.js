import { providerResult, SourceStatus } from "../providers/providerResult.js";
import { createContextCache } from "./contextCache.js";
import { aggregateContext, freshnessScore } from "./contextScore.js";
import { dedupeContextEvents } from "./dedupe.js";
import { matchContextEventToFixture } from "./fixtureMatching.js";
import { normalizeContextEvent } from "./contextTypes.js";
import { fetchFootboomForecasts } from "./providers/footboom.js";
import { fetchInterviewContext } from "./providers/interviews.js";
import { fetchClubNewsContext } from "./providers/clubNews.js";
import { fetchTelegramContext } from "./providers/telegram.js";

function emptyAnalysis(enabled, status = "NO_CONTEXT") {
  return {
    enabled, shadowOnly: true, status,
    scoreHome: 0, scoreAway: 0, confidence: 0,
    independentSources: 0, contradictions: 0,
    home: { positive: 0, negative: 0, confidence: 0, score: 0 },
    away: { positive: 0, negative: 0, confidence: 0, score: 0 },
    match: { intensity: 0, uncertainty: 0 }, events: []
  };
}

export function analyzeContextForFixtures({ fixtures = [], events = [], now = new Date() }) {
  const byFixtureId = Object.fromEntries(fixtures.map(fixture => [fixture.id, emptyAnalysis(true)]));
  const matched = [];
  const unmatched = [];
  for (const raw of events) {
    const event = normalizeContextEvent(raw);
    const match = event.fixtureId
      ? { fixture: fixtures.find(fixture => String(fixture.id) === event.fixtureId), confidence: event.fixtureMatchConfidence || 100 }
      : matchContextEventToFixture(event, fixtures);
    if (!match?.fixture) { unmatched.push(event); continue; }
    const publishedTime = new Date(event.publishedAt).getTime();
    const kickoffTime = new Date(match.fixture.utcDate).getTime();
    if (Number.isFinite(publishedTime) && (publishedTime > now.getTime() || publishedTime >= kickoffTime)) {
      unmatched.push({ ...event, unmatchedReason: "TEMPORAL_SAFETY" });
      continue;
    }
    const relevance = Math.max(event.relevance, match.confidence);
    const freshness = event.publishedAt ? freshnessScore(event.publishedAt, now) : event.freshness;
    const contextConfidence = Math.round(Math.cbrt(Math.max(0, event.sourceReliability * relevance * freshness)));
    matched.push({ ...event, fixtureId: String(match.fixture.id), fixtureMatchConfidence: match.confidence, relevance, freshness, contextConfidence, confidence: contextConfidence });
  }

  for (const fixture of fixtures) {
    const unique = dedupeContextEvents(matched.filter(event => event.fixtureId === String(fixture.id)));
    const aggregate = aggregateContext(unique);
    byFixtureId[fixture.id] = {
      enabled: true, shadowOnly: true, status: unique.length ? "OK" : "NO_CONTEXT",
      scoreHome: aggregate.home.score, scoreAway: aggregate.away.score,
      confidence: aggregate.confidence, independentSources: aggregate.independentSources,
      contradictions: aggregate.contradictions, ...aggregate
    };
  }
  return { byFixtureId, unmatched };
}

export function createContextEngine({ config, runtimeRoot, providers = {}, now = () => new Date() }) {
  const cache = createContextCache(runtimeRoot, { debug: config.debug });
  const implementations = {
    footboom: providers.footboom || fetchFootboomForecasts,
    interviews: providers.interviews || fetchInterviewContext,
    clubNews: providers.clubNews || fetchClubNewsContext,
    telegram: providers.telegram || fetchTelegramContext
  };

  async function safeProvider(source, run) {
    try { return await run(); }
    catch (error) {
      return providerResult({ status: SourceStatus.ERROR, source, data: [], error: { code: error.name || "ERROR", message: error.message }, meta: { nonFatal: true } });
    }
  }

  async function collectFixtures(fixtures = []) {
    if (!config.enabled) {
      return {
        byFixtureId: Object.fromEntries(fixtures.map(fixture => [fixture.id, emptyAnalysis(false, "DISABLED")])),
        providerResults: [providerResult({ status: SourceStatus.NA, source: "context", data: [], meta: { reason: "DISABLED", shadowOnly: true } })],
        unmatched: []
      };
    }

    const cachedFootboom = cache.get("footboom", config.footboomTtlMinutes, now());
    const footboom = cachedFootboom
      ? providerResult({ status: SourceStatus.OK, source: "context.footboom", data: cachedFootboom, meta: { cacheHit: true } })
      : await safeProvider("context.footboom", () => implementations.footboom({ timeoutSeconds: config.timeoutSeconds, reliability: config.reliability.FOOTBOOM, now: now() }));
    if (!cachedFootboom && footboom.status === SourceStatus.OK) cache.set("footboom", footboom.data, now());

    const results = await Promise.all([
      Promise.resolve(footboom),
      safeProvider("context.interviews", () => implementations.interviews({ sources: [] })),
      safeProvider("context.club-news", () => implementations.clubNews({ sources: [] })),
      safeProvider("context.telegram", () => implementations.telegram({ channels: config.telegramChannels }))
    ]);
    const events = results.flatMap(result => Array.isArray(result?.data) ? result.data : []);
    const analysis = analyzeContextForFixtures({ fixtures, events, now: now() });
    return { ...analysis, providerResults: results };
  }

  return { collectFixtures, cacheFile: cache.file };
}
