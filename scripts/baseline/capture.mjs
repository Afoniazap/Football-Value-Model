// Read-only baseline capture of the CURRENT FVM behaviour (no network, no keys, nothing in src/ is touched).
//   node scripts/baseline/capture.mjs [--state data/state.json] [--snapshots data/history/state-snapshots]
//        [--db data/history/football.sqlite] [--predictions data/statistics/predictions.jsonl] [--out data/baseline/<stamp>]
// Writes <out>/baseline.json (control tuples + digest) and <out>/snapshots.json (time series from saved states).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { args, canonicalJson, controlTuple, gitInfo, readJson, sha256, summarize } from "./lib.mjs";

const a = args();
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
const out = path.resolve(typeof a.out === "string" ? a.out : path.join("data", "baseline", stamp));
fs.mkdirSync(out, { recursive: true });

const stateFile = typeof a.state === "string" ? a.state : "data/state.json";
const snapshotDir = typeof a.snapshots === "string" ? a.snapshots : "data/history/state-snapshots";
const dbFile = typeof a.db === "string" ? a.db : "data/history/football.sqlite";
const predictionsFile = typeof a.predictions === "string" ? a.predictions : "data/statistics/predictions.jsonl";

const baseline = { schema: 1, capturedAt: new Date().toISOString(), git: gitInfo(), node: process.version, files: {} };

// 1. Current state: control tuple per fixture.
if (fs.existsSync(stateFile)) {
  const state = readJson(stateFile);
  const tuples = (state.results || []).map(controlTuple).sort((x, y) => x.id.localeCompare(y.id) || x.fixture.localeCompare(y.fixture));
  baseline.state = { file: stateFile, updatedAt: state.updatedAt ?? null, summary: summarize(tuples), fixtures: tuples };
  baseline.digest = sha256(canonicalJson(tuples));
} else baseline.files.state = "MISSING";

// 2. SQLite census (counts only).
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const q = sql => db.prepare(sql).all();
  baseline.db = {
    file: dbFile,
    matches: q("SELECT COUNT(*) n FROM matches")[0].n,
    nullCompetition: q("SELECT COUNT(*) n FROM matches WHERE competitionCode IS NULL")[0].n,
    byCompetitionSeason: q("SELECT competitionCode code, season, COUNT(*) matches FROM matches GROUP BY competitionCode, season ORDER BY competitionCode, season"),
    bySource: q("SELECT source, COUNT(*) rows, SUM(homeTeamId IS NULL OR awayTeamId IS NULL) rowsWithoutTeamId FROM matches GROUP BY source ORDER BY source"),
    multiSourceMatches: q("SELECT COUNT(*) n FROM (SELECT matchId FROM match_sources GROUP BY matchId HAVING COUNT(*)>1)")[0].n,
    identityKeyDuplicates: q("SELECT COUNT(*) n FROM (SELECT identityKey FROM matches GROUP BY identityKey HAVING COUNT(*)>1)")[0].n,
    latestKickoff: q("SELECT MAX(kickoff) k FROM matches")[0].k
  };
  db.close();
} else baseline.files.db = "MISSING";

// 3. Logged predictions: counts only (the log itself is never copied or modified).
if (fs.existsSync(predictionsFile)) {
  const events = fs.readFileSync(predictionsFile, "utf8").split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const countBy = key => events.reduce((o, e) => (o[e[key] ?? "none"] = (o[e[key] ?? "none"] || 0) + 1, o), {});
  baseline.predictions = { file: predictionsFile, events: events.length, byType: countBy("type"), byModelVersion: countBy("modelVersion"), byCategory: countBy("category") };
} else baseline.files.predictions = "MISSING";

fs.writeFileSync(path.join(out, "baseline.json"), JSON.stringify(baseline, null, 2), "utf8");

// 4. Time series from saved state snapshots (48h retention): how each fixture moved between refreshes.
const series = {};
if (fs.existsSync(snapshotDir)) {
  for (const file of fs.readdirSync(snapshotDir).filter(f => /^state-.*\.json$/.test(f)).sort()) {
    let state; try { state = readJson(path.join(snapshotDir, file)); } catch { continue; }
    const at = file.replace(/^state-|\.json$/g, "");
    for (const result of state.results || []) {
      const tuple = controlTuple(result);
      (series[`${tuple.utcDate}|${tuple.fixture}`] ??= []).push({ snapshot: at, ...tuple });
    }
  }
}
fs.writeFileSync(path.join(out, "snapshots.json"), JSON.stringify(series, null, 2), "utf8");

console.log(JSON.stringify({
  out, git: baseline.git, digest: baseline.digest ?? null,
  state: baseline.state?.summary ?? baseline.files.state, db: baseline.db ? { matches: baseline.db.matches, identityKeyDuplicates: baseline.db.identityKeyDuplicates } : baseline.files.db,
  snapshotFixtures: Object.keys(series).length
}, null, 1));
