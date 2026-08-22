import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContextEvent, ContextCategory, ContextSentiment, ContextTarget, EvidenceType } from "../src/context/contextTypes.js";
import { dedupeContextEvents } from "../src/context/dedupe.js";
import { aggregateContext, freshnessScore } from "../src/context/contextScore.js";
import { matchContextEventToFixture } from "../src/context/fixtureMatching.js";
import { analyzeContextForFixtures, createContextEngine } from "../src/context/contextEngine.js";
import { collectContextWithinDeadline, runWithinDeadline } from "../src/context/deadline.js";
import { fetchFootboomForecasts, parseFootboomForecasts } from "../src/context/providers/footboom.js";
import { SourceStatus } from "../src/providers/providerResult.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const now = new Date("2026-08-21T12:00:00Z");
const fixture = {
  id: "600", competitionCode: "FL1", competition: "Ligue 1",
  utcDate: "2026-08-21T18:00:00Z", home: "Olympique de Marseille", away: "RC Strasbourg Alsace"
};

function event(overrides = {}) {
  return normalizeContextEvent({
    source: "official-club", sourceType: "CLUB", evidenceType: EvidenceType.QUOTE,
    homeTeam: fixture.home, awayTeam: fixture.away, publishedAt: "2026-08-21T09:00:00Z",
    title: "Coach expects strongest XI", text: "The coach expects the strongest XI.",
    category: ContextCategory.COACH_INTERVIEW, sentiment: ContextSentiment.POSITIVE,
    target: ContextTarget.HOME, sourceReliability: 90, relevance: 90, freshness: 95,
    contextConfidence: 85, tags: ["lineup", "coach"], ...overrides
  });
}

function testNormalizationAndMissingFields() {
  const normalized = normalizeContextEvent({ title: "Incomplete" });
  assert.equal(normalized.category, ContextCategory.OTHER);
  assert.equal(normalized.target, ContextTarget.UNKNOWN);
  assert.equal(normalized.extracted.market, null);
  assert.equal(normalized.sourceReliability, 0);
}

function testDuplicateRemoval() {
  const first = event({ source: "club", url: "https://club.test/a" });
  const repost = event({ source: "media", url: "https://media.test/repost" });
  const unique = dedupeContextEvents([first, repost]);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].independentSourcesCount, 2);
}

function testReliabilityAndTargeting() {
  const strong = aggregateContext([event({ sourceReliability: 90 })]);
  const weak = aggregateContext([event({ sourceReliability: 20 })]);
  assert.ok(strong.home.score > weak.home.score);
  assert.equal(strong.away.score, 0);
  assert.ok(strong.home.positive > 0);
}

function testFreshnessDecay() {
  assert.ok(freshnessScore("2026-08-21T11:00:00Z", now) > freshnessScore("2026-08-17T12:00:00Z", now));
  assert.equal(freshnessScore("2026-08-22T12:00:00Z", now), 0);
}

function testContradictions() {
  const positive = event({ sentiment: ContextSentiment.POSITIVE, tags: ["player-9", "availability"] });
  const negative = event({ source: "media", sentiment: ContextSentiment.NEGATIVE, tags: ["player-9", "injury"] });
  const result = aggregateContext([positive, negative]);
  assert.equal(result.contradictions, 1);
  assert.ok(result.events.every(item => item.contradiction));
  assert.ok(result.match.uncertainty > 0);
}

function testFixtureMatching() {
  const matched = matchContextEventToFixture({
    homeTeam: "Olympique Marseille", awayTeam: "Strasbourg Alsace",
    publishedAt: "2026-08-21T10:00:00Z", competition: "FL1"
  }, [fixture]);
  assert.equal(matched.fixture.id, fixture.id);
  assert.ok(matched.confidence >= 75);
  assert.equal(matchContextEventToFixture({ homeTeam: "United", awayTeam: "City" }, [fixture]), null);
}

function testFootboomParser() {
  const html = fs.readFileSync(path.join(here, "fixtures", "footboom-forecast.html"), "utf8");
  const parsed = parseFootboomForecasts(html, { now });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].evidenceType, EvidenceType.EXPERT_OPINION);
  assert.equal(parsed[0].extracted.market, "DNB");
  assert.equal(parsed[0].extracted.selection, "Marseille");
  assert.equal(parsed[0].extracted.odds, 1.85);
  assert.equal(parsed[0].author, parsed[0].extracted.author);
  assert.equal(parsed[0].evidence.extractionMethod, "FOOTBOOM_FORECAST_PAGE");
}

async function testProviderTimeoutAndCloudflare() {
  const failed = await fetchFootboomForecasts({ fetchPage: async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); } });
  assert.equal(failed.status, SourceStatus.ERROR);
  assert.equal(failed.meta.nonFatal, true);
  const blocked = await fetchFootboomForecasts({ fetchPage: async () => '<span id="challenge-error-text">blocked</span>' });
  assert.equal(blocked.status, SourceStatus.NA);
  assert.equal(blocked.meta.reason, "CLOUDFLARE_CHALLENGE");
}

async function testEngineShadowAndNonFatalFailure() {
  const analysis = analyzeContextForFixtures({ fixtures: [fixture], events: [event()], now });
  assert.ok(analysis.byFixtureId[fixture.id].scoreHome > 0);
  assert.equal(analysis.byFixtureId[fixture.id].shadowOnly, true);
  const leaked = analyzeContextForFixtures({
    fixtures: [fixture], events: [event({ publishedAt: "2026-08-21T19:00:00Z" })], now: new Date("2026-08-21T20:00:00Z")
  });
  assert.equal(leaked.byFixtureId[fixture.id].events.length, 0);
  assert.equal(leaked.unmatched[0].unmatchedReason, "TEMPORAL_SAFETY");

  const runtimeRoot = fs.mkdtempSync(path.join(process.cwd(), ".context-test-"));
  try {
    const engine = createContextEngine({
      runtimeRoot, now: () => now,
      config: { enabled: true, debug: false, footboomTtlMinutes: 60, timeoutSeconds: 5, telegramChannels: [], reliability: { FOOTBOOM: 60 } },
      providers: {
        footboom: async () => { throw new Error("provider down"); },
        officialSources: async () => ({ providerResults: [], events: [], metrics: {} }),
        telegramPublic: async () => ({ providerResults: [], posts: [] })
      }
    });
    const result = await engine.collectFixtures([fixture]);
    assert.equal(result.providerResults[0].status, SourceStatus.ERROR);
    assert.equal(result.byFixtureId[fixture.id].status, "NO_CONTEXT");
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

testNormalizationAndMissingFields();
testDuplicateRemoval();
testReliabilityAndTargeting();
testFreshnessDecay();
testContradictions();
testFixtureMatching();
testFootboomParser();
await testProviderTimeoutAndCloudflare();
await testEngineShadowAndNonFatalFailure();

const deadlineResult = await collectContextWithinDeadline({
  collect: () => new Promise(() => {}), fixtures: [fixture], timeoutMs: 5
});
assert.equal(deadlineResult.providerResults[0].status, SourceStatus.PARTIAL);
assert.equal(deadlineResult.providerResults[0].meta.reason, "CONTEXT_TIMEOUT");
assert.equal(deadlineResult.byFixtureId[fixture.id].status, "TIMEOUT");
assert.equal(deadlineResult.byFixtureId[fixture.id].shadowOnly, true);
assert.equal(await runWithinDeadline({ run: () => new Promise(() => {}), timeoutMs: 5, timeoutValue: "TIMEOUT" }), "TIMEOUT");

console.log("Stage 11 tests OK: context normalization, scoring, dedupe, contradictions, matching, FootBoom and non-fatal shadow engine.");
