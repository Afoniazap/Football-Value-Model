// Read-only replay of market-bet grading on a COPY of real data.
//   node scripts/replay-market-bet-grading.js [dataDir]
// Copies football.sqlite(+wal/shm) and market-bets.jsonl to a temp dir, runs the
// current grading over the copy and reports what would change. The data
// directory itself is never written.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllHistory, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { buildMarketBetStatistics, updateMarketBetHistory } from "../src/statistics/marketBetHistory.js";
import { resolveHistoryMatch } from "../src/history/resultMatching.js";

const dataDir = path.resolve(process.argv[2] || "data");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-grading-replay-"));
const dbFile = path.join(tmp, "football.sqlite");
for (const ext of ["", "-wal", "-shm"]) {
  const source = path.join(dataDir, "history", `football.sqlite${ext}`);
  if (fs.existsSync(source)) fs.copyFileSync(source, dbFile + ext);
}
const betsFile = path.join(tmp, "market-bets.jsonl");
fs.copyFileSync(path.join(dataDir, "statistics", "market-bets.jsonl"), betsFile);

const lines = buffer => buffer.toString().split("\n").filter(Boolean).map(JSON.parse);
const before = fs.readFileSync(betsFile);
const history = loadAllHistory(openHistoryDatabase(dbFile));
const predictions = new Map(lines(before).filter(row => row.recordType === "PREDICTION").map(row => [row.snapshotKey, row]));

// 1) Existing graded results must resolve to the same score under the new matcher.
const changedExisting = [];
for (const result of lines(before).filter(row => row.type === "MARKET_BET_RESULT")) {
  const prediction = predictions.get(result.snapshotKey);
  const resolution = resolveHistoryMatch(prediction, history, { allowRelaxed: true });
  if (resolution.row && result.score &&
      (resolution.row.score.fullTime.home !== result.score.home || resolution.row.score.fullTime.away !== result.score.away)) {
    changedExisting.push({ snapshotKey: result.snapshotKey, stored: result.score, matcher: resolution.matched });
  }
}

// 2) Run grading over the copy, twice (idempotency).
const now = new Date().toISOString();
const statsBefore = buildMarketBetStatistics(lines(before));
const statsAfter = updateMarketBetHistory(betsFile, [], history, now);
const afterFirst = fs.readFileSync(betsFile);
updateMarketBetHistory(betsFile, [], history, now);
const afterSecond = fs.readFileSync(betsFile);
const added = lines(afterFirst).slice(lines(before).length);
const resultKeys = lines(afterSecond).filter(row => row.type === "MARKET_BET_RESULT").map(row => row.snapshotKey);

console.log(JSON.stringify({
  dataDir, workCopy: tmp,
  existingEventsUntouched: afterFirst.subarray(0, before.length).equals(before),
  existingResultsWithDifferentScoreUnderNewMatcher: changedExisting,
  secondRunAddedEvents: lines(afterSecond).length - lines(afterFirst).length,
  duplicateResultKeys: resultKeys.length - new Set(resultKeys).size,
  recovered: added.filter(row => row.type === "MARKET_BET_RESULT").map(row => {
    const p = predictions.get(row.snapshotKey);
    return { kickoff: p.kickoff, match: `${p.home} - ${p.away}`, category: p.category, market: p.market, selection: p.selection, line: p.line, odds: p.odds,
      settlement: row.settlement, unitProfit: row.unitProfit, score: row.score, matchType: row.matchType, matched: row.matchedRecord };
  }),
  holds: added.filter(row => row.type === "MARKET_BET_GRADING_HOLD"),
  stillPending: [...predictions.values()].filter(p => !lines(afterSecond).some(r => r.type === "MARKET_BET_RESULT" && r.snapshotKey === p.snapshotKey))
    .map(p => `${p.kickoff.slice(0, 10)} ${p.home} - ${p.away} ${p.market} ${p.selection}`),
  statsBefore: { completed: statsBefore.completed, pending: statsBefore.pending, unitProfit: statsBefore.unitProfit, roi: statsBefore.roi, categories: statsBefore.categories },
  statsAfter: { completed: statsAfter.completed, pending: statsAfter.pending, unitProfit: statsAfter.unitProfit, roi: statsAfter.roi, categories: statsAfter.categories }
}, null, 2));
