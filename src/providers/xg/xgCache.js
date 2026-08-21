import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeRoot } from "../../storage/runtime.js";

const WINDOWS = [3, 5, 10];

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function recordKey(record) {
  return [
    record.source,
    record.externalFixtureId,
    record.metricVersion || "actual-xg-v1"
  ].join(":");
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function sideForTeam(record, teamId) {
  if (String(record.homeTeamId) === String(teamId)) {
    return {
      venue: "home",
      for: record.home?.xG ?? null,
      against: record.home?.xGA ?? record.away?.xG ?? null,
      npxG: record.home?.npxG ?? null
    };
  }
  if (String(record.awayTeamId) === String(teamId)) {
    return {
      venue: "away",
      for: record.away?.xG ?? null,
      against: record.away?.xGA ?? record.home?.xG ?? null,
      npxG: record.away?.npxG ?? null
    };
  }
  return null;
}

function rolling(rows, key, limit) {
  return average(rows.slice(0, limit).map(row => row[key]));
}

function trend(rows, key) {
  const recent = average(rows.slice(0, 3).map(row => row[key]));
  const older = average(rows.slice(3, 6).map(row => row[key]));
  return Number.isFinite(recent) && Number.isFinite(older) ? recent - older : null;
}

function teamFeatures(records, teamId, targetKickoff) {
  const rows = records
    .filter(record => new Date(record.kickoff) < new Date(targetKickoff))
    .map(record => {
      const side = sideForTeam(record, teamId);
      return side ? { ...side, kickoff: record.kickoff } : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));

  const features = {
    sampleSize: rows.length,
    coverage: rows.length >= 10 ? "FULL" : rows.length > 0 ? "PARTIAL" : "N/A",
    freshness: rows[0]?.kickoff || null,
    rolling: {},
    homeAway: {
      home: { sampleSize: rows.filter(row => row.venue === "home").length },
      away: { sampleSize: rows.filter(row => row.venue === "away").length }
    },
    derived: {
      xGTrend: trend(rows, "for")
    }
  };

  for (const window of WINDOWS) {
    features.rolling[`xG${window}`] = rolling(rows, "for", window);
    features.rolling[`xGA${window}`] = rolling(rows, "against", window);
    features.rolling[`npxG${window}`] = rolling(rows, "npxG", window);
  }

  for (const venue of ["home", "away"]) {
    const split = rows.filter(row => row.venue === venue);
    features.homeAway[venue].xG5 = rolling(split, "for", 5);
    features.homeAway[venue].xGA5 = rolling(split, "against", 5);
  }

  return features;
}

export function createXgCache(root, { runtimeRoot = resolveRuntimeRoot(root) } = {}) {
  const xgDir = path.join(runtimeRoot, "xg");
  const matchXgFile = path.join(xgDir, "match-xg.jsonl");

  function readRecords() {
    return readJsonl(matchXgFile);
  }

  function appendMatchXg(record) {
    if (!record?.externalFixtureId || !record?.source) return { appended: false, reason: "INVALID_RECORD" };
    const key = recordKey(record);
    const exists = readRecords().some(row => row.dedupeKey === key);
    if (exists) return { appended: false, reason: "DUPLICATE", dedupeKey: key };
    const row = { ...record, dedupeKey: key };
    appendJsonl(matchXgFile, row);
    return { appended: true, dedupeKey: key, record: row };
  }

  function recordsBefore(targetKickoff) {
    return readRecords().filter(record => new Date(record.kickoff) < new Date(targetKickoff));
  }

  function featuresForFixture(fixture) {
    const records = recordsBefore(fixture.utcDate || fixture.kickoff);
    const home = teamFeatures(records, fixture.homeTeamId || fixture.homeId, fixture.utcDate || fixture.kickoff);
    const away = teamFeatures(records, fixture.awayTeamId || fixture.awayId, fixture.utcDate || fixture.kickoff);
    const xGDiff = Number.isFinite(home.rolling.xG5) && Number.isFinite(away.rolling.xG5)
      ? home.rolling.xG5 - away.rolling.xG5
      : null;
    const xGADiff = Number.isFinite(home.rolling.xGA5) && Number.isFinite(away.rolling.xGA5)
      ? away.rolling.xGA5 - home.rolling.xGA5
      : null;
    return {
      fixtureId: fixture.id || fixture.fixtureId,
      targetKickoff: fixture.utcDate || fixture.kickoff,
      status: home.sampleSize || away.sampleSize ? "OK" : "N/A",
      home,
      away,
      derived: {
        xGDiff,
        xGTrend: Number.isFinite(home.derived.xGTrend) && Number.isFinite(away.derived.xGTrend)
          ? home.derived.xGTrend - away.derived.xGTrend
          : null,
        xGAttackStrength: xGDiff,
        xGDefensiveStrength: xGADiff
      }
    };
  }

  return {
    xgDir,
    matchXgFile,
    readRecords,
    appendMatchXg,
    recordsBefore,
    featuresForFixture
  };
}
