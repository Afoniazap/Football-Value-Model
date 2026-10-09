// Compare two JSON files produced by scripts/audit-fixture-forecast.js (e.g. before/after a PR).
//   node scripts/compare-forecast-runs.js before.json after.json
import fs from "node:fs";

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) { console.error("usage: node scripts/compare-forecast-runs.js before.json after.json"); process.exit(2); }
const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
const after = JSON.parse(fs.readFileSync(afterFile, "utf8"));

function flatten(value, prefix = "", out = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
  } else out[prefix] = Array.isArray(value) ? JSON.stringify(value) : value;
  return out;
}
const a = flatten(before), b = flatten(after);
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
let changed = 0;
for (const key of keys) {
  if (a[key] === b[key]) continue;
  changed += 1;
  const delta = Number.isFinite(a[key]) && Number.isFinite(b[key]) ? `  (Δ ${(b[key] - a[key]).toFixed(4)})` : "";
  console.log(`${key}\n  before: ${a[key]}\n  after:  ${b[key]}${delta}`);
}
console.log(changed ? `\n${changed} field(s) differ.` : "No differences.");
