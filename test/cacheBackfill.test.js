import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backfillFromProviderCaches, extractFinishedMatches } from "../src/history/cacheBackfill.js";
import { loadLocalHistory } from "../src/history/localHistory.js";

test("cache extractor принимает только завершённые API-Football fixtures", () => {
  const finished = { fixture: { id: 1, date: "2026-08-01T18:00:00Z", status: { short: "FT" } }, league: { id: 3, name: "Europa", season: 2026 }, teams: { home: { id: 10, name: "A" }, away: { id: 20, name: "B" } }, goals: { home: 2, away: 1 } };
  const future = { ...finished, fixture: { ...finished.fixture, id: 2, status: { short: "NS" } } };
  assert.deepEqual(extractFinishedMatches({ data: { response: [finished, future] } }, "API_FOOTBALL").map(row => row.id), [1]);
});

test("cache backfill сохраняет provenance и дедуплицирует повторные snapshots", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-backfill-"));
  const cacheDir = path.join(dataDir, "football-data-cache");
  const historyFile = path.join(dataDir, "history", "fixtures.jsonl");
  fs.mkdirSync(cacheDir, { recursive: true });
  const match = { id: 7, status: "FINISHED", utcDate: "2026-08-01T18:00:00Z", competition: { id: 1, code: "X", name: "Cup" }, homeTeam: { id: 10, name: "A" }, awayTeam: { id: 20, name: "B" }, score: { fullTime: { home: 1, away: 0 } } };
  fs.writeFileSync(path.join(cacheDir, "one.json"), JSON.stringify({ data: { matches: [match, match] } }));
  assert.equal(backfillFromProviderCaches({ dataDir, historyFile }).added, 1);
  assert.equal(backfillFromProviderCaches({ dataDir, historyFile }).added, 0);
  const rows = loadLocalHistory(historyFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provenance.source, "FOOTBALL_DATA");
});
