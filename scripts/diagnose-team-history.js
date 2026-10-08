// Read-only local diagnostic: why does a fixture have too little history?
//   node scripts/diagnose-team-history.js --home "PSV Eindhoven" --away "Heerenveen" \
//        --kickoff 2026-10-09T18:45:00Z [--code DED] [--season 2026] [--db data/history/football.sqlite]
// Opens the SQLite file READ-ONLY and prints only team-name spellings, sources,
// competition codes and counts. No API keys, no .env access, no match ids/scores,
// nothing is written or sent anywhere. Safe to paste the output.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { diagnoseBaseline, diagnoseFixtureHistory } from "../src/history/historyDiagnostics.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => {
  if (value.startsWith("--")) out.push([value.slice(2), all[index + 1]]);
  return out;
}, []));
const dbFile = path.resolve(args.db || "data/history/football.sqlite");
if (!args.home || !args.away || !args.kickoff) {
  console.error('usage: node scripts/diagnose-team-history.js --home "<team>" --away "<team>" --kickoff <ISO> [--code DED] [--season 2026] [--db <file>]');
  process.exit(2);
}
if (!fs.existsSync(dbFile)) { console.error(`SQLite file not found: ${dbFile}`); process.exit(2); }
const db = new DatabaseSync(dbFile, { readOnly: true });
try {
  const fixture = { home: args.home, away: args.away, competitionCode: args.code || null, utcDate: new Date(args.kickoff).toISOString() };
  console.log(JSON.stringify({
    ...diagnoseFixtureHistory(db, fixture),
    baseline: args.code ? diagnoseBaseline(db, fixture, args.season || null) : null
  }, null, 2));
} finally { db.close(); }
