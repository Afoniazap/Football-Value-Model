import { providerResult, SourceStatus } from "../../providers/providerResult.js";
import { articleFixtureCandidate, classifyArticle, discoverArticleLinks, parseArticlePage } from "../articleParser.js";
import { ContextFetchMode, ContextSourceType, sourcesForFixtures } from "../sourceRegistry.js";
import { mapWithConcurrency } from "../requestControl.js";

export const ContextSourceOutcome = Object.freeze({
  OK: "OK", PARTIAL: "PARTIAL", TIMEOUT: "TIMEOUT", HTTP_ERROR: "HTTP_ERROR",
  PARSE_ERROR: "PARSE_ERROR", BLOCKED: "BLOCKED", UNSUPPORTED: "UNSUPPORTED"
});

function outcomeFromError(error) {
  if (error?.name === "AbortError" || /timeout|aborted/i.test(error?.message || "")) return ContextSourceOutcome.TIMEOUT;
  if ([401, 403].includes(error?.status)) return ContextSourceOutcome.BLOCKED;
  if (error?.status || /^HTTP_/.test(error?.code || "")) return ContextSourceOutcome.HTTP_ERROR;
  return ContextSourceOutcome.PARSE_ERROR;
}

function isBlocked(html) {
  return /challenge-error-text|cf-chl-|captcha|enable javascript and cookies/i.test(String(html || ""));
}

function withinWindow(article, fixture, windowHours, now) {
  const published = new Date(article.publishedAt).getTime();
  const kickoff = new Date(fixture.utcDate).getTime();
  return Number.isFinite(published) && published <= now.getTime() && published < kickoff && published >= kickoff - windowHours * 3_600_000;
}

function resultFor(source, status, data, outcome, meta = {}, error = null) {
  return providerResult({
    status, source: `context.source.${source.id}`, data, error,
    meta: { sourceId: source.id, sourceName: source.name, sourceType: source.type, outcome, nonFatal: true, ...meta }
  });
}

export async function fetchRegisteredContextSources({
  registry, fixtures = [], cache, httpClient, now = new Date(), sourceTtlMinutes = 60,
  articleTtlMinutes = 360, windowHours = 72, maxArticlesPerSource = 3, concurrency = 2
}) {
  const active = sourcesForFixtures(registry, fixtures);
  const results = await mapWithConcurrency(active, concurrency, async source => {
    if (source.fetchMode !== ContextFetchMode.HTML_INDEX) {
      return resultFor(source, SourceStatus.NA, [], ContextSourceOutcome.UNSUPPORTED, { reason: `FETCH_MODE_${source.fetchMode}_NOT_IMPLEMENTED` });
    }

    let indexHtml = cache.get(`source-index:${source.id}`, sourceTtlMinutes, now);
    let cacheHits = indexHtml ? 1 : 0;
    let requestsUsed = 0;
    try {
      if (!indexHtml) {
        requestsUsed += 1;
        indexHtml = await httpClient.fetchText(source.baseUrl, { retry: 1 });
        cache.set(`source-index:${source.id}`, indexHtml, now);
      }
    } catch (error) {
      const outcome = outcomeFromError(error);
      const blocked = outcome === ContextSourceOutcome.BLOCKED;
      return resultFor(source, blocked ? SourceStatus.NA : SourceStatus.ERROR, [], outcome, { requestsUsed, cacheHits }, blocked ? null : { code: error.code || error.name || "ERROR", message: error.message });
    }
    if (isBlocked(indexHtml)) return resultFor(source, SourceStatus.NA, [], ContextSourceOutcome.BLOCKED, { requestsUsed, cacheHits });

    const links = discoverArticleLinks(indexHtml, source);
    if (!links.length) return resultFor(source, SourceStatus.NA, [], ContextSourceOutcome.PARSE_ERROR, { requestsUsed, cacheHits, discoveredLinks: 0 });
    const candidates = links.map(item => ({ item, candidate: articleFixtureCandidate(item, source, fixtures) }))
      .filter(row => row.candidate).slice(0, maxArticlesPerSource);
    if (!candidates.length) {
      return resultFor(source, SourceStatus.OK, [], ContextSourceOutcome.OK, { requestsUsed, cacheHits, discoveredLinks: links.length, relevantLinks: 0 });
    }

    const events = [];
    const failures = [];
    for (const { item, candidate } of candidates) {
      let html = cache.get(`article:${item.url}`, articleTtlMinutes, now);
      if (html) cacheHits += 1;
      try {
        if (!html) {
          requestsUsed += 1;
          html = await httpClient.fetchText(item.url, { retry: 1 });
          cache.set(`article:${item.url}`, html, now);
        }
        if (isBlocked(html)) { failures.push({ url: item.url, outcome: ContextSourceOutcome.BLOCKED }); continue; }
        const article = parseArticlePage(html, item);
        if (!withinWindow(article, candidate.fixture, windowHours, now)) {
          failures.push({ url: item.url, outcome: ContextSourceOutcome.UNSUPPORTED, reason: article.publishedAt ? "OUTSIDE_TEMPORAL_WINDOW" : "PUBLISHED_AT_MISSING" });
          continue;
        }
        events.push(classifyArticle({ article, source, fixture: candidate.fixture, target: candidate.target }));
      } catch (error) {
        failures.push({ url: item.url, outcome: outcomeFromError(error), error: error.message });
      }
    }
    const outcome = failures.length ? (events.length ? ContextSourceOutcome.PARTIAL : failures[0].outcome) : ContextSourceOutcome.OK;
    const status = events.length ? (failures.length ? SourceStatus.PARTIAL : SourceStatus.OK)
      : failures.length ? SourceStatus.NA : SourceStatus.OK;
    return resultFor(source, status, events, outcome, {
      requestsUsed, cacheHits, discoveredLinks: links.length, relevantLinks: candidates.length,
      itemsDiscovered: events.length, failures
    });
  });

  const events = results.flatMap(result => result.data || []);
  const official = results.filter(result => [ContextSourceType.OFFICIAL_CLUB, ContextSourceType.OFFICIAL_LEAGUE, ContextSourceType.OFFICIAL_FEDERATION].includes(result.meta.sourceType));
  const media = results.filter(result => result.meta.sourceType === ContextSourceType.REPUTABLE_MEDIA);
  return {
    providerResults: results,
    events,
    metrics: {
      sourcesSelected: active.length,
      official: { ok: official.filter(result => [SourceStatus.OK, SourceStatus.PARTIAL].includes(result.status)).length, failed: official.filter(result => ![SourceStatus.OK, SourceStatus.PARTIAL].includes(result.status)).length },
      media: { ok: media.filter(result => [SourceStatus.OK, SourceStatus.PARTIAL].includes(result.status)).length, failed: media.filter(result => ![SourceStatus.OK, SourceStatus.PARTIAL].includes(result.status)).length },
      itemsDiscovered: events.length
    }
  };
}
