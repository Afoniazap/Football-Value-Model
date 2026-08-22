import assert from "node:assert/strict";
import {
  FlashscoreOutcome,
  compareFlashscoreFacts,
  fetchFlashscoreVerification,
  matchFlashscoreFixture,
  parseFlashscoreDetail,
  parseFlashscoreIndex,
  parseFlashscoreStats
} from "../src/providers/flashscore.js";

const indexHtml = `<div id="score-data">
<h4>FRANCE: Ligue 1 <a href="/standings/">Standings</a></h4>
<span>20:45</span>Marseille - Strasbourg <a href="/match/abc123/" class="sched">&nbsp;-&nbsp;</a><br />
</div>`;
const fixture = { id: 42, home: "Olympique de Marseille", away: "RC Strasbourg Alsace", utcDate: "2026-08-22T18:45:00Z", competitionCode: "FL1" };

function memoryCache() {
  const state = new Map();
  return { get: key => state.get(key) || null, set: (key, value) => state.set(key, value) };
}

function testParsingMatchingAliasesAndNormalization() {
  const candidates = parseFlashscoreIndex(indexHtml);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].competition, "Ligue 1");
  assert.deepEqual(candidates[0].score, null);
  const match = matchFlashscoreFixture(fixture, candidates);
  assert.equal(match.candidate.externalId, "abc123");
  assert.equal(match.confidence, 1);
  assert.equal(matchFlashscoreFixture({ ...fixture, home: fixture.away, away: fixture.home }, candidates), null);
  assert.equal(matchFlashscoreFixture({ ...fixture, competitionCode: "PL" }, candidates), null);

  const stats = parseFlashscoreStats("1.42 Expected goals (xG) 0.71 58% Ball possession 42% 7 Shots on target 3");
  assert.deepEqual(stats["Expected goals (xG)"], { home: 1.42, away: 0.71 });
  assert.deepEqual(stats["Ball possession"], { home: 58, away: 42 });
  assert.deepEqual(stats["Shots on target"], { home: 7, away: 3 });

  const detail = parseFlashscoreDetail({
    summaryHtml: "<main>22.08.2026 20:45 Marseille 2 - 1 Strasbourg</main>",
    lineupHtml: "<p>Clicking on a player opens his profile. Marseille Player One Strasbourg Player Two</p>",
    statsHtml: "1.42 Expected goals (xG) 0.71",
    h2hHtml: "22.05.2026 Marseille - Strasbourg 2 - 1",
    matched: candidates[0]
  });
  assert.equal(detail.kickoff.date, "2026-08-22");
  assert.deepEqual(detail.score, { home: 2, away: 1 });
  assert.equal(detail.lineups.published, true);
  assert.equal(detail.lineups.startingXI, null);
  assert.equal(detail.injuries, null);
  assert.equal(detail.suspensions, null);
  assert.deepEqual(detail.statistics["Expected goals (xG)"], { home: 1.42, away: 0.71 });
}

async function testCacheAndDuplicateSuppression() {
  const pages = new Map([
    ["https://www.flashscore.mobi/", indexHtml],
    ["https://www.flashscore.mobi/match/abc123/", "22.08.2026 20:45 Marseille 2 - 1 Strasbourg"],
    ["https://www.flashscore.mobi/match/abc123/?s=2.&t=lineups", "Clicking on a player opens his profile"],
    ["https://www.flashscore.mobi/match/abc123/?s=2.&t=stats", "1.42 Expected goals (xG) 0.71"],
    ["https://www.flashscore.mobi/match/abc123/?s=2.&t=h2h", "22.05.2026 Marseille - Strasbourg 2 - 1"]
  ]);
  let requests = 0;
  const cache = memoryCache();
  const httpClient = { fetchText: async url => { requests += 1; return pages.get(url); } };
  const first = await fetchFlashscoreVerification({ fixtures: [fixture, fixture], httpClient, cache });
  assert.equal(first.data.length, 2);
  assert.equal(requests, 5);
  const second = await fetchFlashscoreVerification({ fixtures: [fixture], httpClient, cache });
  assert.equal(second.data.length, 1);
  assert.equal(requests, 5);
  assert.ok(second.meta.cacheHits >= 5);
}

async function testBlockedTimeoutAndHttpFailure() {
  const blocked = await fetchFlashscoreVerification({ fixtures: [fixture], cache: memoryCache(), httpClient: { fetchText: async () => "<div>verify you are human</div>" } });
  assert.equal(blocked.meta.outcome, FlashscoreOutcome.BLOCKED);
  assert.equal(blocked.status, "N/A");

  const timeoutError = new Error("Request timeout"); timeoutError.name = "AbortError";
  const timeout = await fetchFlashscoreVerification({ fixtures: [fixture], cache: memoryCache(), httpClient: { fetchText: async () => { throw timeoutError; } } });
  assert.equal(timeout.meta.outcome, FlashscoreOutcome.TIMEOUT);
  assert.equal(timeout.meta.nonFatal, true);

  const httpError = new Error("HTTP 500"); httpError.status = 500;
  const failure = await fetchFlashscoreVerification({ fixtures: [fixture], cache: memoryCache(), httpClient: { fetchText: async () => { throw httpError; } } });
  assert.equal(failure.meta.outcome, FlashscoreOutcome.HTTP_ERROR);
  assert.equal(failure.status, "ERROR");
}

function testConflictIsRecordedNotOverridden() {
  const comparisons = compareFlashscoreFacts({
    fixture,
    primary: { score: { home: 1, away: 1 }, scoreSource: "FOOTBALL_DATA" },
    flashscore: { kickoff: { display: "22.08.2026 20:45" }, score: { home: 2, away: 1 }, lineups: null }
  });
  assert.equal(comparisons.find(row => row.field === "score").agreement, false);
  assert.equal(comparisons.find(row => row.field === "kickoff").agreement, null);
}

testParsingMatchingAliasesAndNormalization();
await testCacheAndDuplicateSuppression();
await testBlockedTimeoutAndHttpFailure();
testConflictIsRecordedNotOverridden();
console.log("Stage 16 tests OK: Flashscore parsing, normalization, aliases, matching, cache, failures and discrepancies.");
