// Compare two baseline.json files (before/after a change). Exit code 1 if any LOCKED field differs.
//   node scripts/baseline/compare.mjs before/baseline.json after/baseline.json [--tolerance 0]
// Locked fields = the control values the owner asked to keep: category, coverage, DQ, Agreement, Stability, probabilities.
import { args, readJson } from "./lib.mjs";

const a = args();
const [beforeFile, afterFile] = a._;
if (!beforeFile || !afterFile) { console.error("usage: node scripts/baseline/compare.mjs before.json after.json [--tolerance 0]"); process.exit(2); }
const tolerance = Number(a.tolerance || 0);
const before = readJson(beforeFile), after = readJson(afterFile);

const LOCKED = ["category", "modelsAvailable", "modelCoverage", "dq", "agreement", "stability", "consensus.home", "consensus.draw", "consensus.away"];
function flat(value, prefix = "", out = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) flat(v, prefix ? `${prefix}.${k}` : k, out);
  else out[prefix] = Array.isArray(value) ? JSON.stringify(value) : value;
  return out;
}
const differs = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) > tolerance : x !== y);

const index = state => new Map((state.state?.fixtures || []).map(t => [`${t.utcDate}|${t.fixture}`, t]));
const b = index(before), f = index(after);
const lockedDiffs = [], otherDiffs = [];
for (const key of new Set([...b.keys(), ...f.keys()])) {
  if (!b.has(key) || !f.has(key)) { lockedDiffs.push({ fixture: key, field: "PRESENCE", before: b.has(key), after: f.has(key) }); continue; }
  const x = flat(b.get(key)), y = flat(f.get(key));
  for (const field of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!differs(x[field], y[field])) continue;
    const row = { fixture: key, field, before: x[field], after: y[field] };
    (LOCKED.includes(field) ? lockedDiffs : otherDiffs).push(row);
  }
}
const dbDiff = flat({ matches: before.db?.matches, identityKeyDuplicates: before.db?.identityKeyDuplicates });
const dbAfter = flat({ matches: after.db?.matches, identityKeyDuplicates: after.db?.identityKeyDuplicates });
console.log(JSON.stringify({
  before: { git: before.git?.commit, digest: before.digest }, after: { git: after.git?.commit, digest: after.digest },
  summaryBefore: before.state?.summary, summaryAfter: after.state?.summary,
  db: { before: dbDiff, after: dbAfter },
  lockedDifferences: lockedDiffs.length, otherDifferences: otherDiffs.length,
  locked: lockedDiffs.slice(0, 200), other: otherDiffs.slice(0, 200)
}, null, 1));
process.exit(lockedDiffs.length ? 1 : 0);
