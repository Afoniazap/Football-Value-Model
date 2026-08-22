import { providerResult, SourceStatus } from "../providers/providerResult.js";
import { createContextCache } from "./contextCache.js";
import { aggregateContext, freshnessScore } from "./contextScore.js";
import { dedupeContextEvents } from "./dedupe.js";
import { matchContextEventToFixture } from "./fixtureMatching.js";
import { normalizeContextEvent } from "./contextTypes.js";
import { fetchFootboomForecasts } from "./providers/footboom.js";
import { fetchTelegramContext, normalizeTelegramPost } from "./providers/telegram.js";
import { fetchRegisteredContextSources } from "./providers/officialSources.js";
import { combineContextSourceRegistries, createSourceRegistry, DEFAULT_CONTEXT_SOURCES } from "./sourceRegistry.js";
import { createContextHttpClient } from "./requestControl.js";
import { createTelegramSourceRegistry, OWNER_SUPPLIED_TELEGRAM_IDENTIFIERS } from "./telegramRegistry.js";
import { createTelegramInbox } from "./telegramInbox.js";
import { resolveTelegramIdentifiers } from "./telegramResolver.js";
import { fetchPublicTelegramSources } from "./providers/telegramPublic.js";

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

  let uniqueCount = 0;
  for (const fixture of fixtures) {
    const unique = dedupeContextEvents(matched.filter(event => event.fixtureId === String(fixture.id)));
    uniqueCount += unique.length;
    const aggregate = aggregateContext(unique);
    byFixtureId[fixture.id] = {
      enabled: true, shadowOnly: true, status: unique.length ? "OK" : "NO_CONTEXT",
      scoreHome: aggregate.home.score, scoreAway: aggregate.away.score,
      confidence: aggregate.confidence, independentSources: aggregate.independentSources,
      contradictions: aggregate.contradictions, ...aggregate
    };
  }
  return { byFixtureId, unmatched, metrics: { itemsMatched: matched.length, duplicatesRemoved: Math.max(0, matched.length - uniqueCount) } };
}

export function createContextEngine({ config, runtimeRoot, providers = {}, now = () => new Date() }) {
  const cache = createContextCache(runtimeRoot, { debug: config.debug });
  const registry = createSourceRegistry({
    sources: config.sourceRegistry || DEFAULT_CONTEXT_SOURCES,
    enabledIds: config.enabledSourceIds,
    reliabilityByType: config.reliability
  });
  const httpClient = providers.httpClient || createContextHttpClient({ timeoutSeconds: config.timeoutSeconds, minHostIntervalMs: config.minHostIntervalMs });
  const telegramRegistry = createTelegramSourceRegistry({ additionalNames: config.telegramChannels });
  const telegramInbox = createTelegramInbox(runtimeRoot);
  let telegramAuthStatus = providers.telegramAuthStatus || (providers.telegram ? "VALID" : "UNKNOWN");
  let telegramAccess = [];
  const sourceRegistry = combineContextSourceRegistries(registry, telegramRegistry);
  const implementations = {
    footboom: providers.footboom || fetchFootboomForecasts,
    telegram: providers.telegram || fetchTelegramContext,
    telegramPublic: providers.telegramPublic || fetchPublicTelegramSources
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

    const registered = await safeProvider("context.sources", () => (providers.officialSources || fetchRegisteredContextSources)({
      registry, fixtures, cache, httpClient, now: now(), sourceTtlMinutes: config.sourceTtlMinutes,
      articleTtlMinutes: config.articleTtlMinutes, windowHours: config.sourceWindowHours,
      maxArticlesPerSource: config.maxArticlesPerSource, concurrency: config.sourceConcurrency
    }));
    const registeredResults = registered?.providerResults || (registered?.source ? [registered] : []);
    const telegramPublic = await safeProvider("context.telegram-public", () => implementations.telegramPublic({
      sources: telegramRegistry, httpClient, cache, now: now(),
      ttlMinutes: config.sourceTtlMinutes, concurrency: config.sourceConcurrency
    }));
    const publicPosts = telegramPublic?.posts || [];
    telegramInbox.appendPosts(publicPosts);
    const telegramPublicResults = telegramPublic?.providerResults || (telegramPublic?.source ? [telegramPublic] : []);
    const results = await Promise.all([
      Promise.resolve(footboom),
      ...registeredResults,
      ...telegramPublicResults,
      safeProvider("context.telegram", () => implementations.telegram({
        sources: telegramRegistry,
        posts: [...publicPosts, ...(providers.telegramPosts || telegramInbox.readRecent())]
      }))
    ]);
    const events = results.flatMap(result => Array.isArray(result?.data) ? result.data : []);
    const analysis = analyzeContextForFixtures({ fixtures, events, now: now() });
    const metrics = { ...(registered?.metrics || {}), ...analysis.metrics, itemsDiscovered: events.length };
    if (config.debug) {
      console.debug(`[context] Official: ${metrics.official?.ok || 0} OK / ${metrics.official?.failed || 0} failed | Media: ${metrics.media?.ok || 0} OK / ${metrics.media?.failed || 0} failed | Items discovered: ${metrics.itemsDiscovered} | Items matched: ${metrics.itemsMatched} | Duplicates removed: ${metrics.duplicatesRemoved}`);
    }
    return { ...analysis, metrics, providerResults: results };
  }

  return {
    collectFixtures, cacheFile: cache.file, registry, telegramRegistry, sourceRegistry,
    telegramInboxFile: telegramInbox.file,
    ingestTelegramUpdate: update => {
      const post = telegramInbox.appendUpdate(update, telegramRegistry);
      if (!post) return null;
      const source = telegramRegistry.find(item => item.id === post.sourceId);
      const normalized = normalizeTelegramPost(post, source);
      return {
        source: source.channelName, messageId: normalized.messageId,
        sport: normalized.sport, type: normalized.telegramPostType,
        pickExtracted: Boolean(normalized.pick)
      };
    },
    setTelegramAuthStatus: status => { telegramAuthStatus = status; },
    resolveTelegramAccess: async (getChat, getChatMember, botId) => {
      const resolution = await resolveTelegramIdentifiers({ identifiers: OWNER_SUPPLIED_TELEGRAM_IDENTIFIERS, registry: telegramRegistry, getChat });
      if (getChatMember && botId != null) {
        for (const item of resolution.results.filter(result => result.accessibility === "ACCESSIBLE" && result.channelId != null)) {
          try {
            const membership = await getChatMember(item.channelId, botId);
            item.membership = membership.status || "UNKNOWN";
            item.administrator = ["administrator", "creator"].includes(membership.status);
            item.canReceiveChannelPosts = item.chatType === "channel" ? item.administrator : !["left", "kicked"].includes(item.membership);
          } catch {
            item.membership = "UNKNOWN"; item.administrator = null; item.canReceiveChannelPosts = null;
          }
        }
      }
      telegramRegistry.splice(0, telegramRegistry.length, ...resolution.registry);
      telegramAccess = resolution.results;
      return telegramAccess;
    },
    telegramReadiness: () => ({ authStatus: telegramAuthStatus, registeredSources: telegramRegistry.length, suppliedIdentifiers: OWNER_SUPPLIED_TELEGRAM_IDENTIFIERS.length, resolved: telegramRegistry.filter(source => source.resolutionStatus === "RESOLVED").length, accessible: telegramAccess.filter(item => item.accessibility === "ACCESSIBLE").length, waitingForChannelPosts: telegramAuthStatus === "VALID" })
  };
}
