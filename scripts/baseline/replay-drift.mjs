// Read-only replay: how far does the input layer move the 1X2 of already-logged predictions across commits?
// For every PREDICTION in data/statistics/predictions.jsonl (kickoff in the last N days) it runs scripts/audit-fixture-forecast.js
// in a temporary git worktree of each commit. No network, no keys; worktrees are removed afterwards.
//   node scripts/baseline/replay-drift.mjs <days> <sqlite> <commit> [<commit> ...] > replay-drift.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const [days = "14", dbArg = "data/history/football.sqlite", ...commits] = process.argv.slice(2);
const db = path.resolve(dbArg), root = process.cwd();
const since = Date.now() - Number(days) * 86400e3;
const preds = fs.readFileSync("data/statistics/predictions.jsonl", "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
  .filter(e => e.type === "PREDICTION" && Date.parse(e.kickoff) > since && Date.parse(e.kickoff) < Date.now());
const script = fs.readFileSync("scripts/audit-fixture-forecast.js", "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-replay-"));
const trees = commits.map(c => {
  const dir = path.join(tmp, c);
  spawnSync("git", ["worktree", "add", "--detach", dir, c], { cwd: root });
  fs.writeFileSync(path.join(dir, "scripts", "audit-fixture-forecast.js"), script);
  try { fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules")); } catch {}
  return { commit: c, dir };
});
const rows = [];
for (const p of preds) {
  const row = { fixture: `${p.home} - ${p.away}`, kickoff: p.kickoff, logged: p.probability, byCommit: {} };
  for (const t of trees) {
    spawnSync("node", ["scripts/audit-fixture-forecast.js", "--home", p.home, "--away", p.away, "--kickoff", p.kickoff,
      "--code", p.competitionCode || "", "--db", db, "--out", path.join(tmp, "out.json")], { cwd: t.dir, encoding: "utf8" });
    try { const j = JSON.parse(fs.readFileSync(path.join(tmp, "out.json"), "utf8")); fs.rmSync(path.join(tmp, "out.json")); row.byCommit[t.commit] = j.models.consensus?.probability ?? null; }
    catch { row.byCommit[t.commit] = "ERROR"; }
  }
  rows.push(row);
}
for (const t of trees) spawnSync("git", ["worktree", "remove", "--force", t.dir], { cwd: root });
spawnSync("git", ["worktree", "prune"], { cwd: root });
console.log(JSON.stringify({ predictions: rows.length, commits, rows }, null, 1));