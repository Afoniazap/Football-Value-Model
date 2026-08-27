import fs from "node:fs";
import path from "node:path";
import { appendLocalHistory, normalizeHistoryMatch } from "./localHistory.js";

const API_FINISHED = new Set(["FT", "AET", "PEN"]);

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
  } else {
    for (const item of Object.values(value)) walk(item, visit, seen);
  }
}

function apiFootballMatch(value) {
  if (!value.fixture?.id || !value.teams?.home?.name || !value.teams?.away?.name) return null;
  if (!API_FINISHED.has(value.fixture?.status?.short)) return null;
  return {
    id: value.fixture.id,
    utcDate: value.fixture.date,
    leagueId: value.league?.id ?? null,
    league: value.league?.name ?? null,
    country: value.league?.country ?? null,
    season: value.league?.season ?? null,
    homeTeam: value.teams.home,
    awayTeam: value.teams.away,
    score: { fullTime: { home: value.goals?.home, away: value.goals?.away } },
    statistics: value.statistics ?? null
  };
}

function footballDataMatch(value) {
  if (!value.id || value.status !== "FINISHED" || !value.homeTeam?.name || !value.awayTeam?.name) return null;
  return {
    id: value.id,
    utcDate: value.utcDate,
    competition: value.competition ?? null,
    competitionCode: value.competition?.code ?? null,
    season: value.season?.startDate ?? null,
    homeTeam: value.homeTeam,
    awayTeam: value.awayTeam,
    score: { fullTime: value.score?.fullTime ?? null },
    statistics: value.statistics ?? null
  };
}

export function extractFinishedMatches(payload, source) {
  const matches = [];
  const keys = new Set();
  walk(payload, value => {
    const match = source === "API_FOOTBALL" ? apiFootballMatch(value) : footballDataMatch(value);
    if (!match) return;
    const normalized = normalizeHistoryMatch(match, source);
    if (!normalized || keys.has(normalized.recordKey)) return;
    keys.add(normalized.recordKey);
    matches.push(match);
  });
  return matches;
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...jsonFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(fullPath);
  }
  return files;
}

export function backfillFromProviderCaches({ dataDir, historyFile }) {
  const sources = [
    { source: "API_FOOTBALL", directories: ["api-football", "api-football-cache"] },
    { source: "FOOTBALL_DATA", directories: ["football-data-cache", path.join("backtests", "raw")] }
  ];
  const report = { files: 0, parsed: 0, invalid: 0, found: 0, added: 0, bySource: {} };

  for (const definition of sources) {
    const sourceReport = { files: 0, found: 0, added: 0 };
    const sourceMatches = [];
    for (const relative of definition.directories) {
      for (const file of jsonFiles(path.join(dataDir, relative))) {
        report.files++; sourceReport.files++;
        try {
          const payload = JSON.parse(fs.readFileSync(file, "utf8"));
          report.parsed++;
          const matches = extractFinishedMatches(payload, definition.source);
          report.found += matches.length; sourceReport.found += matches.length;
          sourceMatches.push(...matches);
        } catch {
          report.invalid++;
        }
      }
    }
    sourceReport.added = appendLocalHistory(historyFile, sourceMatches, definition.source);
    report.added += sourceReport.added;
    report.bySource[definition.source] = sourceReport;
  }
  return report;
}
