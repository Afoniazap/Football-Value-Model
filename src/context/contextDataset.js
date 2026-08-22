import fs from "node:fs";
import path from "node:path";

export function createContextDataset(runtimeRoot) {
  const file = path.join(runtimeRoot, "context", "analyses.jsonl");
  function append({ analysisId, analysedAt, fixtures, metrics, unmatched }) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({
        analysisId, analysedAt, shadowOnly: true, metrics,
        fixtures: fixtures.map(item => ({
          fixtureId: item.id, kickoff: item.utcDate, home: item.home, away: item.away,
          contextAnalysis: item.contextAnalysis
        })),
        unmatched: (unmatched || []).map(event => ({
          source: event.source, title: event.title, url: event.url,
          publishedAt: event.publishedAt, fixtureMatchConfidence: event.fixtureMatchConfidence,
          unmatchedReason: event.unmatchedReason || "LOW_MATCH_CONFIDENCE"
        }))
      }) + "\n", "utf8");
      return true;
    } catch { return false; }
  }
  return { append, file };
}
