// Records what the CURRENT identity code does with the real name corpus (golden output for the P1 compatibility tests).
//   node scripts/baseline/identity-legacy-snapshot.mjs name-corpus.json > identity-legacy-snapshot.json
// Sections (each with its own sha256): per-name canonical keys; equivalence classes of the history layer (sameTeamIdentity);
// pairs the odds matcher accepts (clubNameSimilarity >= 0.85); the ids alignContextTeamIds re-assigns for each fixture spelling.
// Read-only, deterministic, no network. When src/identity/ exists it must reproduce every section exactly.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalTeamIdentity, canonicalTeamName, sameTeamIdentity, teamSearchAliases } from "../../src/history/teamAliases.js";
import { clubNameSimilarity } from "../../src/engine/clubMatching.js";
import { alignContextTeamIds } from "../../src/engine/contextIds.js";
import { canonicalJson, sha256 } from "./lib.mjs";

export function legacyIdentitySnapshot(corpus) {
  const byCompetition = new Map();
  for (const row of corpus) {
    const key = row.competition ?? "∅";
    if (!byCompetition.has(key)) byCompetition.set(key, new Set());
    byCompetition.get(key).add(row.name);
  }
  const sections = { names: {}, historyClasses: {}, oddsPairs: {}, contextAlignment: {} };
  for (const [competition, set] of [...byCompetition].sort((a, b) => a[0].localeCompare(b[0]))) {
    const names = [...set].sort();
    sections.names[competition] = names.map(name => ({
      name, canonicalName: canonicalTeamName(name), identity: canonicalTeamIdentity(name),
      searchKeys: [...new Set(teamSearchAliases(name).map(canonicalTeamName))].sort()
    }));
    // history layer: connected components of sameTeamIdentity
    const parent = new Map(names.map(n => [n, n]));
    const find = n => (parent.get(n) === n ? n : (parent.set(n, find(parent.get(n))), parent.get(n)));
    const oddsPairs = [];
    for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
      if (sameTeamIdentity(names[i], names[j])) parent.set(find(names[i]), find(names[j]));
      const score = clubNameSimilarity(names[i], names[j]);
      if (score >= 0.85) oddsPairs.push([names[i], names[j], score]);
    }
    const classes = new Map();
    for (const n of names) classes.set(find(n), [...(classes.get(find(n)) || []), n]);
    sections.historyClasses[competition] = [...classes.values()].filter(c => c.length > 1).map(c => c.sort()).sort((a, b) => a[0].localeCompare(b[0]));
    sections.oddsPairs[competition] = oddsPairs;
    // context alignment: for each spelling as the fixture's home team, which standings rows get that team's id
    const table = names.map((name, index) => ({ team: { id: index + 1, name }, playedGames: 1 }));
    const alignment = {};
    for (const name of names) {
      const aligned = alignContextTeamIds({ standings: { standings: [{ type: "TOTAL", table }] }, finished: [] }, { home: name, away: "\u0000none", homeId: 1_000_000, awayId: 1_000_001 });
      alignment[name] = aligned.standings.standings[0].table.filter(row => row.team.id === 1_000_000).map(row => row.team.name).sort();
    }
    sections.contextAlignment[competition] = alignment;
  }
  const digests = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, sha256(canonicalJson(v))]));
  return { schema: 1, names: corpus.length, competitions: byCompetition.size, digests, digest: sha256(canonicalJson(digests)), sections };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/baseline/identity-legacy-snapshot.mjs name-corpus.json"); process.exit(2); }
  console.log(JSON.stringify(legacyIdentitySnapshot(JSON.parse(fs.readFileSync(file, "utf8"))), null, 1));
}
