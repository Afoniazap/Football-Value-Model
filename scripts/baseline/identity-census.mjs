// Read-only identity census of the local SQLite: logical duplicates, alias candidates derived from DATA, rows without team ids.
// Output = team-name spellings, sources and counts only (no ids, no scores).
//   node scripts/baseline/identity-census.mjs [data/history/football.sqlite] > identity-census.json
import { DatabaseSync } from "node:sqlite";
const file = process.argv[2] || "data/history/football.sqlite";
const db = new DatabaseSync(file, { readOnly: true });
const q = sql => db.prepare(sql).all();
const out = {};
out.totals = q("SELECT COUNT(*) matches, COUNT(DISTINCT competitionCode) competitions, SUM(competitionCode IS NULL) nullCompetition FROM matches")[0];
out.bySource = q("SELECT source, COUNT(*) rows, SUM(homeTeamId IS NULL OR awayTeamId IS NULL) rowsWithoutTeamId FROM matches GROUP BY source");
out.multiSourceRows = q("SELECT COUNT(*) n FROM (SELECT matchId FROM match_sources GROUP BY matchId HAVING COUNT(*)>1)")[0].n;
const rows = q("SELECT id, competitionCode code, kickoff, homeTeamNormalized h, awayTeamNormalized a, homeGoals hg, awayGoals ag, source FROM matches WHERE competitionCode IS NOT NULL ORDER BY competitionCode, kickoff");
const byCode = new Map();
for (const r of rows) { const list = byCode.get(r.code) || []; list.push({ ...r, t: Date.parse(r.kickoff) }); byCode.set(r.code, list); }
const candidates = new Map(), perCode = {};
let exactPairDuplicates = 0;
for (const [code, list] of byCode) {
  perCode[code] = { rows: list.length, aliasCandidatePairs: 0, exactPairDuplicates: 0 };
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && list[j].t - list[i].t < 12 * 3600e3; j++) {
    const x = list[i], y = list[j];
    if (x.hg !== y.hg || x.ag !== y.ag) continue;
    if (x.h === y.h && x.a === y.a) { exactPairDuplicates++; perCode[code].exactPairDuplicates++; continue; }
    let pair = null;
    if (x.h === y.h && x.a !== y.a) pair = [x.a, y.a]; else if (x.a === y.a && x.h !== y.h) pair = [x.h, y.h];
    if (!pair) continue;
    const key = `${code}|${[...pair].sort().join(" <=> ")}`;
    const c = candidates.get(key) || { code, pair: [...pair].sort(), matches: 0, sources: new Set() };
    c.matches++; c.sources.add(x.source); c.sources.add(y.source); candidates.set(key, c);
    perCode[code].aliasCandidatePairs++;
  }
}
out.exactPairDuplicatesWithDifferentIdentityKey = exactPairDuplicates;
out.perCompetition = perCode;
out.aliasCandidates = [...candidates.values()].sort((a, b) => b.matches - a.matches).slice(0, 60).map(c => ({ competition: c.code, spellings: c.pair, evidenceMatches: c.matches, sources: [...c.sources] }));
console.log(JSON.stringify(out, null, 1));