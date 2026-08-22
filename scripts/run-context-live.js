import { loadConfig } from "../src/config/env.js";
import { fetchFixtures } from "../src/providers/footballData.js";
import { createContextEngine } from "../src/context/contextEngine.js";

function request(timeoutSeconds) {
  return async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } finally { clearTimeout(timeout); }
  };
}

const config = loadConfig();
const fixturesResult = await fetchFixtures({
  request: request(config.requestTimeoutSeconds),
  token: config.footballDataToken,
  horizonHours: config.horizonHours
});
const fixtures = fixturesResult.data || [];
const engine = createContextEngine({
  config: { ...config.context, enabled: true, debug: true },
  runtimeRoot: config.runtimeRoot
});
const result = await engine.collectFixtures(fixtures);
const withContext = fixtures.filter(fixture => result.byFixtureId[fixture.id]?.events?.length);
const examples = withContext.flatMap(fixture =>
  result.byFixtureId[fixture.id].events.slice(0, 2).map(event => ({
    fixture: `${fixture.home} - ${fixture.away}`,
    source: event.source,
    evidenceType: event.evidenceType,
    category: event.category,
    title: event.title,
    publishedAt: event.publishedAt,
    snippet: event.evidence?.snippet || null,
    url: event.url
  }))).slice(0, 10);

console.log(JSON.stringify({
  shadowOnly: true,
  fixturesChecked: fixtures.length,
  fixturesWithContext: withContext.length,
  metrics: result.metrics,
  sources: result.providerResults.map(provider => ({
    source: provider.source, status: provider.status,
    outcome: provider.meta?.outcome || provider.meta?.reason || null,
    items: provider.data?.length || 0,
    requestsUsed: provider.meta?.requestsUsed || 0,
    cacheHits: provider.meta?.cacheHits || 0,
    error: provider.error ? { code: provider.error.code, message: provider.error.message } : null
  })),
  examples,
  unmatchedItems: result.unmatched.length
}, null, 2));
