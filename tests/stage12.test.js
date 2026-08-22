import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSourceRegistry, ContextFetchMode, ContextSourceType, sourcesForFixtures } from "../src/context/sourceRegistry.js";
import { articleFixtureCandidate, classifyArticle, discoverArticleLinks, extractContextSignals, extractQuote, parseArticlePage } from "../src/context/articleParser.js";
import { normalizeClubName } from "../src/context/fixtureMatching.js";
import { createContextCache } from "../src/context/contextCache.js";
import { createContextHttpClient, mapWithConcurrency } from "../src/context/requestControl.js";
import { ContextSourceOutcome, fetchRegisteredContextSources } from "../src/context/providers/officialSources.js";
import { createContextDataset } from "../src/context/contextDataset.js";
import { SourceStatus } from "../src/providers/providerResult.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(here, "fixtures", "official-news-index.html"), "utf8");
const articleHtml = fs.readFileSync(path.join(here, "fixtures", "official-article.html"), "utf8");
const fixture = { id: "700", competitionCode: "SA", utcDate: "2026-08-22T16:30:00Z", home: "FC Internazionale Milano", away: "AC Monza" };
const source = {
  id: "inter-test", name: "Inter Test", type: ContextSourceType.OFFICIAL_CLUB,
  baseUrl: "https://official.test/en/news", reliability: 90, competitions: ["SA"],
  teams: ["FC Internazionale Milano"], enabled: true, fetchMode: ContextFetchMode.HTML_INDEX,
  linkPattern: "/en/news/"
};
const now = new Date("2026-08-22T13:00:00Z");

function testSourceRegistry() {
  const registry = createSourceRegistry({ sources: [source], reliabilityByType: { OFFICIAL_CLUB: 91 } });
  assert.equal(registry.length, 1);
  assert.equal(registry[0].reliability, 91);
  assert.equal(sourcesForFixtures(registry, [fixture]).length, 1);
  assert.equal(sourcesForFixtures(registry, [{ ...fixture, competitionCode: "PL" }]).length, 0);
}

function testDiscoveryAndDuplicateLinks() {
  const links = discoverArticleLinks(indexHtml, source);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, "https://official.test/en/news/inter-monza-team-news");
  const candidate = articleFixtureCandidate(links[0], source, [fixture]);
  assert.equal(candidate.fixture.id, fixture.id);
  assert.equal(candidate.target, "HOME");
  assert.equal(articleFixtureCandidate({ title: "Generic academy update", url: "https://official.test/en/news/academy" }, source, [fixture]), null);
}

function testParsingQuoteSignalsAndEvidence() {
  const article = parseArticlePage(articleHtml, { url: "https://official.test/en/news/inter-monza-team-news" });
  assert.equal(article.publishedAt, "2026-08-21T12:00:00Z");
  assert.equal(article.author, "Official Club Media");
  const quote = extractQuote(article, fixture.home);
  assert.equal(quote.speaker, "Marco Testa");
  assert.equal(quote.role, "COACH");
  assert.ok(quote.quoteText.startsWith("We will use"));
  const signals = extractContextSignals(article);
  assert.ok(signals.some(signal => signal.type === "STRONGEST_XI"));
  assert.ok(signals.some(signal => signal.type === "TACTICAL_CHANGE"));
  assert.ok(signals.every(signal => signal.snippet && signal.extractionMethod.startsWith("RULE:")));
  const event = classifyArticle({ article, source, fixture, target: "HOME" });
  assert.equal(event.evidenceType, "QUOTE");
  assert.equal(event.author, "Official Club Media");
  assert.equal(event.category, "COACH_INTERVIEW");
  assert.equal(event.eventType, "COACH_INTERVIEW");
  assert.equal(event.informationLevel, "HIGH");
  assert.equal(event.evidence.sourceUrl, article.url);
  assert.equal(event.evidence.speaker, "Marco Testa");
  assert.equal(event.extracted.coachQuote, quote.quoteText);
  assert.equal(event.extracted.tacticalHint, true);
}

function testGenericMotivationIsLowInformation() {
  const event = classifyArticle({
    article: {
      title: "Coach speaks before Monza",
      publishedAt: "2026-08-21T12:00:00Z",
      author: "Official Club Media",
      url: "https://official.test/generic",
      text: 'Marco Testa said "We will give everything and fight until the end."'
    },
    source, fixture, target: "HOME"
  });
  assert.equal(event.eventType, "COACH_INTERVIEW");
  assert.equal(event.informationLevel, "LOW_INFORMATION");
  assert.equal(event.relevance, 20);
}

function testAliases() {
  assert.equal(normalizeClubName("Manchester United FC"), normalizeClubName("Man Utd"));
  assert.equal(normalizeClubName("FC Internazionale Milano"), normalizeClubName("Inter Milan"));
  assert.equal(normalizeClubName("Paris Saint-Germain FC"), normalizeClubName("PSG"));
}

async function testRateLimitAndConcurrency() {
  let clock = 1_000;
  const waits = [];
  const client = createContextHttpClient({
    fetchImpl: async () => ({ ok: true, text: async () => "ok" }), minHostIntervalMs: 500,
    nowMs: () => clock, wait: async ms => { waits.push(ms); clock += ms; }
  });
  await client.fetchText("https://rate.test/a", { retry: 0 });
  clock += 100;
  await client.fetchText("https://rate.test/b", { retry: 0 });
  assert.deepEqual(waits, [400]);
  let active = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4], 2, async value => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1; return value;
  });
  assert.equal(peak, 2);
}

async function testProviderCacheTemporalWindowAndFailure() {
  const runtimeRoot = fs.mkdtempSync(path.join(process.cwd(), ".context-stage12-"));
  try {
    const cache = createContextCache(runtimeRoot);
    let requests = 0;
    const httpClient = { fetchText: async url => { requests += 1; return url.endsWith("/en/news") ? indexHtml : articleHtml; } };
    const args = { registry: [source], fixtures: [fixture], cache, httpClient, now, sourceTtlMinutes: 60, articleTtlMinutes: 60, windowHours: 72, maxArticlesPerSource: 2, concurrency: 1 };
    const first = await fetchRegisteredContextSources(args);
    assert.equal(first.events.length, 1);
    assert.equal(first.providerResults[0].status, SourceStatus.OK);
    assert.equal(requests, 2);
    const second = await fetchRegisteredContextSources(args);
    assert.equal(second.events.length, 1);
    assert.equal(requests, 2);
    assert.ok(second.providerResults[0].meta.cacheHits >= 2);

    const outside = await fetchRegisteredContextSources({ ...args, fixtures: [{ ...fixture, utcDate: "2026-09-01T16:30:00Z" }] });
    assert.equal(outside.events.length, 0);
    assert.equal(outside.providerResults[0].meta.failures[0].reason, "OUTSIDE_TEMPORAL_WINDOW");

    const failed = await fetchRegisteredContextSources({ ...args, cache: createContextCache(path.join(runtimeRoot, "failure")), httpClient: { fetchText: async () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; } } });
    assert.equal(failed.providerResults[0].status, SourceStatus.ERROR);
    assert.equal(failed.providerResults[0].meta.outcome, ContextSourceOutcome.TIMEOUT);

    const dataset = createContextDataset(runtimeRoot);
    assert.equal(dataset.append({ analysisId: "a1", analysedAt: now.toISOString(), fixtures: [{ ...fixture, contextAnalysis: { shadowOnly: true } }], metrics: first.metrics, unmatched: [] }), true);
    assert.equal(fs.readFileSync(dataset.file, "utf8").trim().split(/\r?\n/).length, 1);
  } finally { fs.rmSync(runtimeRoot, { recursive: true, force: true }); }
}

testSourceRegistry();
testDiscoveryAndDuplicateLinks();
testParsingQuoteSignalsAndEvidence();
testGenericMotivationIsLowInformation();
testAliases();
await testRateLimitAndConcurrency();
await testProviderCacheTemporalWindowAndFailure();

console.log("Stage 12 tests OK: source registry, discovery, parsing, quotes, signals, evidence, aliases, relevance, temporal window, failures, cache, rate limits and dataset.");
