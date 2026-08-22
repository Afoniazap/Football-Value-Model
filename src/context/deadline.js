import { providerResult, SourceStatus } from "../providers/providerResult.js";

function emptyContextAnalysis() {
  return {
    enabled: true, shadowOnly: true, status: "TIMEOUT",
    scoreHome: 0, scoreAway: 0, confidence: 0,
    independentSources: 0, contradictions: 0,
    home: { positive: 0, negative: 0, confidence: 0, score: 0 },
    away: { positive: 0, negative: 0, confidence: 0, score: 0 },
    match: { intensity: 0, uncertainty: 0 }, events: []
  };
}

function fallback(fixtures, result) {
  return {
    byFixtureId: Object.fromEntries(fixtures.map(fixture => [fixture.id, emptyContextAnalysis()])),
    providerResults: [result], unmatched: [], metrics: result.meta
  };
}

export async function collectContextWithinDeadline({ collect, fixtures = [], timeoutMs }) {
  let timer;
  const collection = Promise.resolve().then(() => collect(fixtures)).catch(error => fallback(fixtures, providerResult({
    status: SourceStatus.ERROR, source: "context", data: [],
    error: { code: error.name || "ERROR", message: error.message },
    meta: { shadowOnly: true, nonFatal: true, failed: true }
  })));
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback(fixtures, providerResult({
      status: SourceStatus.PARTIAL, source: "context", data: [],
      meta: { reason: "CONTEXT_TIMEOUT", timeoutMs, shadowOnly: true, nonFatal: true, timedOut: true }
    }))), timeoutMs);
  });
  const result = await Promise.race([collection, deadline]);
  clearTimeout(timer);
  return result;
}

export async function runWithinDeadline({ run, timeoutMs, timeoutValue }) {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  const result = await Promise.race([Promise.resolve().then(run), deadline]);
  clearTimeout(timer);
  return result;
}
