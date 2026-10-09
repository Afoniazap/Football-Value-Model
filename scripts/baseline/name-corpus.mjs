// Read-only: every distinct team spelling per competition and source, with row counts (names only).
// This is the golden INPUT for the identity compatibility tests (P1): the same names are fed to the legacy functions and,
// later, to src/identity/.
//   node scripts/baseline/name-corpus.mjs [data/history/football.sqlite] [data/state.json] > name-corpus.json
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dbFile = process.argv[2] || "data/history/football.sqlite";
const stateFile = process.argv[3] || "data/state.json";
const names = new Map();
const add = (competition, source, name, kind, n = 1) => {
  if (!name) return;
  const key = `${competition ?? ""}|${source ?? ""}|${name}|${kind}`;
  names.set(key, { competition: competition ?? null, source: source ?? null, name, kind, rows: (names.get(key)?.rows || 0) + n });
};
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  for (const row of db.prepare("SELECT competitionCode c, source s, homeTeam n, COUNT(*) k FROM matches GROUP BY c, s, n").all()) add(row.c, row.s, row.n, "sqlite", row.k);
  for (const row of db.prepare("SELECT competitionCode c, source s, awayTeam n, COUNT(*) k FROM matches GROUP BY c, s, n").all()) add(row.c, row.s, row.n, "sqlite", row.k);
  db.close();
}
if (fs.existsSync(stateFile)) {
  for (const result of JSON.parse(fs.readFileSync(stateFile, "utf8")).results || []) {
    add(result.competitionCode, "STATE", result.home, "fixture");
    add(result.competitionCode, "STATE", result.away, "fixture");
  }
}
console.log(JSON.stringify([...names.values()].sort((a, b) => `${a.competition}|${a.name}`.localeCompare(`${b.competition}|${b.name}`)), null, 1));
