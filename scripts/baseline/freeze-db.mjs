// Read-only snapshot of the SQLite into ONE standalone file (VACUUM INTO: WAL-safe, source untouched).
// A frozen copy makes before/after comparisons of the identity layer reproducible while the live database keeps growing.
//   node scripts/baseline/freeze-db.mjs data/history/football.sqlite data/baseline/<stamp>/football.frozen.sqlite
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [source = "data/history/football.sqlite", target] = process.argv.slice(2);
if (!target) { console.error("usage: node scripts/baseline/freeze-db.mjs <source.sqlite> <target.sqlite>"); process.exit(2); }
if (fs.existsSync(target)) { console.error(`refusing to overwrite ${target}`); process.exit(2); }
fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
db.exec(`VACUUM INTO '${path.resolve(target).replaceAll("'", "''")}'`);
db.close();
const check = new DatabaseSync(target, { readOnly: true });
const matches = check.prepare("SELECT COUNT(*) n FROM matches").get().n;
check.close();
console.log(JSON.stringify({ frozen: path.resolve(target), matches }));
