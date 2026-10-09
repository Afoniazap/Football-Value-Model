// Read-only: do two entries of state.results describe the same real fixture (different spellings, different keys)?
//   node scripts/baseline/fixture-dup-census.mjs [data/state.json | data/history/state-snapshots/state-<ts>.json]
import fs from "node:fs";
import { canonicalTeamName, canonicalTeamIdentity } from "../../src/history/teamAliases.js";

const results = JSON.parse(fs.readFileSync(process.argv[2] || "data/state.json", "utf8")).results || [];
const pairs = [];
for (let i = 0; i < results.length; i += 1) for (let j = i + 1; j < results.length; j += 1) {
  const a = results[i], b = results[j];
  if (Math.abs(Date.parse(a.utcDate) - Date.parse(b.utcDate)) >= 12 * 3600e3) continue;
  const sameHome = canonicalTeamName(a.home) === canonicalTeamName(b.home), sameAway = canonicalTeamName(a.away) === canonicalTeamName(b.away);
  const sameHomeId = canonicalTeamIdentity(a.home) === canonicalTeamIdentity(b.home), sameAwayId = canonicalTeamIdentity(a.away) === canonicalTeamIdentity(b.away);
  if ((sameHome && sameAway) || !(sameHomeId || sameAwayId)) continue;
  pairs.push({
    kind: sameHomeId && sameAwayId ? "SAME_FIXTURE_DIFFERENT_KEY" : "ONE_CLUB_SAME_TIME_OTHER_SPELLING",
    a: `${a.home} - ${a.away}`, b: `${b.home} - ${b.away}`, kickoffs: [a.utcDate, b.utcDate], categories: [a.category, b.category]
  });
}
console.log(JSON.stringify({ fixtures: results.length, suspectedDuplicateFixtures: pairs }, null, 1));
