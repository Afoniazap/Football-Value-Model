import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backfillFromProviderCaches } from "../src/history/cacheBackfill.js";
import { buildLocalHistoryContext, loadLocalHistory } from "../src/history/localHistory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const historyFile = path.join(dataDir, "history", "fixtures.jsonl");
const legacyFile = path.join(dataDir, "history.json");
const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
const fixtures = (state.results || []).filter(row => row.apiFootballLeagueId === 3);
const cache = backfillFromProviderCaches({ dataDir, historyFile });
const history = loadLocalHistory(historyFile, legacyFile);
const teams = fixtures.flatMap(fixture => {
  const context = buildLocalHistoryContext(history, fixture);
  return [
    { name: fixture.home, id: fixture.homeId, matches: context.contextMeta.homeMatches, sources: context.contextMeta.homeSources },
    { name: fixture.away, id: fixture.awayId, matches: context.contextMeta.awayMatches, sources: context.contextMeta.awaySources }
  ];
});

console.log(JSON.stringify({
  cache,
  totalHistory: history.length,
  teams,
  summary: {
    ge3: teams.filter(team => team.matches >= 3).length,
    ge5: teams.filter(team => team.matches >= 5).length,
    ge10: teams.filter(team => team.matches >= 10).length,
    ge15: teams.filter(team => team.matches >= 15).length
  }
}, null, 2));
