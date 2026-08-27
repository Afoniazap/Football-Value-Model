import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureApiFootball, getFinishedFixturesForDate } from "../src/connectors/apiFootball.js";
import { configureTheSportsDb, getFreeTeamPreviousEvents, getTheSportsDbTelemetry, resetTheSportsDbTelemetry } from "../src/connectors/theSportsDb.js";
import { appendLocalHistory, buildLocalHistoryContext, loadLocalHistory } from "../src/history/localHistory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const historyFile = path.join(dataDir, "history", "fixtures.jsonl");
const legacyFile = path.join(dataDir, "history.json");
const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
const fixtures = (state.results || []).filter(row => row.apiFootballLeagueId === 3);
const targets = [...new Map(fixtures.flatMap(row => [[row.homeId, row.home], [row.awayId, row.away]]).map(([id, name]) => [String(id), { id, name }])).values()];

configureTheSportsDb({ cacheDir: path.join(dataDir, "thesportsdb-cache") });
configureApiFootball({ cacheDir: path.join(dataDir, "api-football-cache") });
resetTheSportsDbTelemetry();
const sourceResults = [];
const dates = new Set();

for (const target of targets) {
  try {
    const result = await getFreeTeamPreviousEvents(target.name);
    const added = appendLocalHistory(historyFile, result.matches, "THESPORTSDB");
    for (const match of result.matches) dates.add(String(match.utcDate).slice(0, 10));
    sourceResults.push({ ...target, status: result.status, providerTeamId: result.team?.id || null, returned: result.matches.length, added });
  } catch (error) {
    sourceResults.push({ ...target, status: "ERROR", reason: error.message, returned: 0, added: 0 });
  }
}

let apiFootballRequests = 0, apiFootballAdded = 0, apiFootballBlocker = null;
const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const eligibleDates = [...dates].filter(date => date >= yesterday).sort();
const skippedPlanDates = [...dates].filter(date => date < yesterday).sort();
for (const date of eligibleDates) {
  try {
    const matches = await getFinishedFixturesForDate(process.env.API_FOOTBALL_KEY?.trim(), date);
    apiFootballRequests++;
    apiFootballAdded += appendLocalHistory(historyFile, matches, "API_FOOTBALL");
  } catch (error) {
    apiFootballBlocker = error.code || error.message;
    break;
  }
}

const history = loadLocalHistory(historyFile, legacyFile);
const teams = fixtures.flatMap(fixture => {
  const context = buildLocalHistoryContext(history, fixture);
  return [
    { name: fixture.home, id: fixture.homeId, matches: context.contextMeta.homeMatches, sources: context.contextMeta.homeSources },
    { name: fixture.away, id: fixture.awayId, matches: context.contextMeta.awayMatches, sources: context.contextMeta.awaySources }
  ];
});

console.log(JSON.stringify({ sourceResults, theSportsDb: getTheSportsDbTelemetry(), dates: [...dates].sort(), apiFootball: { requests: apiFootballRequests, added: apiFootballAdded, blocker: apiFootballBlocker, skippedPlanDates }, teams }, null, 2));
