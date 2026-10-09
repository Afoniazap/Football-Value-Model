// Read-only: which matches does the Form model use for each club, and why did its PPG change?
//
//   node scripts/audit-form-window.js --home "PSV Eindhoven" --away "Heerenveen" \
//        --kickoff 2026-10-09T18:45:00Z [--db data/history/football.sqlite] [--out form-window.json]
//
// Rebuilds, from the local SQLite only (no network/keys, nothing written), the context the Form
// model sees in three states and lists the exact last-8 window of both clubs in each:
//   BEFORE_PR5  rows as they were returned before PR #5 (no logical de-duplication)
//   PR5         SQLite rows de-duplicated, context merge as in PR #5
//   CURRENT     SQLite rows de-duplicated AND context merge de-duplicated by club identity
// Per match: record key, provider fixture id, kickoff, teams, score, result for the club, points,
// sources, size of its logical-duplicate group and whether duplicate scores disagree. The live
// pipeline also merges the live provider's `finished` list (already appended to SQLite on every
// refresh, so SQLite is the closest offline stand-in).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getTeamLastMatches, getTeamLastMatchesUndeduped } from "../src/history/sqliteHistory.js";
import { mergeWithLocalHistory } from "../src/history/localHistory.js";
import { isSameLogicalMatch, matchSignature } from "../src/history/logicalMatch.js";
import { formModel, formStats, recentMatches } from "../src/engine/models.js";

function duplicateInfo(finished, row) {
  const signature = matchSignature(row);
  const twins = finished.filter(other => other === row || isSameLogicalMatch(matchSignature(other), signature));
  const scores = new Set(twins.map(other => `${other.score?.fullTime?.home}:${other.score?.fullTime?.away}`));
  return { groupSize: twins.length, scoreConflict: scores.size > 1, sources: [...new Set(twins.map(other => other.provenance?.source).filter(Boolean))] };
}

function windowFor(finished, teamId, label) {
  const matches = recentMatches({ finished }, teamId, 8);
  const rows = matches.map((match, index) => {
    const home = match.homeTeam.id === teamId;
    const goalsFor = Number(home ? match.score.fullTime.home : match.score.fullTime.away);
    const goalsAgainst = Number(home ? match.score.fullTime.away : match.score.fullTime.home);
    const points = goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;
    return {
      rank: index + 1, id: match.id, utcDate: match.utcDate,
      fixture: `${match.homeTeam.name} - ${match.awayTeam.name}`, venue: home ? "H" : "A",
      score: `${match.score.fullTime.home}:${match.score.fullTime.away}`,
      result: points === 3 ? "W" : points === 1 ? "D" : "L", points, ...duplicateInfo(finished, match)
    };
  });
  const stats = formStats(matches, teamId);
  return { club: label, games: rows.length, points: rows.reduce((sum, row) => sum + row.points, 0), ppg: stats.ppg === null ? null : Number(stats.ppg.toFixed(3)), matches: rows };
}

// Same data, different input order: Form must not depend on it.
function deterministic(fixture, finished) {
  const baseline = JSON.stringify(formModel(fixture, { finished })?.probability);
  const orders = [[...finished].reverse(), [...finished].sort((a, b) => String(a.id).localeCompare(String(b.id))), [...finished].sort(() => 0.5 - Math.random())];
  return orders.every(order => JSON.stringify(formModel(fixture, { finished: order })?.probability) === baseline);
}

export function auditFormWindow(db, fixtureInput) {
  const fixture = { id: "audit", ...fixtureInput, homeId: fixtureInput.homeId ?? -1, awayId: fixtureInput.awayId ?? -2 };
  const rowsOf = (getter) => [...new Map([
    ...getter(db, { name: fixture.home }, fixture.utcDate, 20), ...getter(db, { name: fixture.away }, fixture.utcDate, 20)
  ].map(row => [row.recordKey, row])).values()];
  const variants = {
    BEFORE_PR5: { history: rowsOf(getTeamLastMatchesUndeduped), options: { logicalDedupe: false } },
    PR5: { history: rowsOf(getTeamLastMatches), options: { logicalDedupe: false } },
    CURRENT: { history: rowsOf(getTeamLastMatches), options: { logicalDedupe: true } }
  };
  const out = { fixture: { home: fixture.home, away: fixture.away, utcDate: fixture.utcDate }, variants: {} };
  for (const [name, { history, options }] of Object.entries(variants)) {
    const merged = mergeWithLocalHistory({ standings: null, finished: [], scheduled: [] }, history, fixture, options);
    const form = formModel(fixture, merged);
    const homeWindow = windowFor(merged.finished, fixture.homeId, fixture.home);
    const awayWindow = windowFor(merged.finished, fixture.awayId, fixture.away);
    out.variants[name] = {
      sqliteRows: history.length, contextFinished: merged.finished.length,
      home: homeWindow, away: awayWindow,
      form: form ? { probability: form.probability, explanation: form.explanation } : null,
      deterministicUnderReordering: deterministic(fixture, merged.finished)
    };
  }
  const ids = variant => new Set(out.variants[variant].home.matches.map(match => `${match.utcDate}|${match.fixture}`));
  out.homeWindowChanges = {
    droppedByPR5: [...ids("BEFORE_PR5")].filter(key => !ids("PR5").has(key)),
    addedByPR5: [...ids("PR5")].filter(key => !ids("BEFORE_PR5").has(key)),
    droppedByCurrent: [...ids("PR5")].filter(key => !ids("CURRENT").has(key)),
    addedByCurrent: [...ids("CURRENT")].filter(key => !ids("PR5").has(key))
  };
  return out;
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => {
    if (value.startsWith("--")) out.push([value.slice(2), all[index + 1]]);
    return out;
  }, []));
  if (!args.home || !args.away || !args.kickoff) {
    console.error('usage: node scripts/audit-form-window.js --home "<team>" --away "<team>" --kickoff <ISO> [--db <file>] [--out <file>]');
    process.exit(2);
  }
  const dbFile = path.resolve(args.db || "data/history/football.sqlite");
  if (!fs.existsSync(dbFile)) { console.error(`SQLite file not found: ${dbFile}`); process.exit(2); }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = auditFormWindow(db, { home: args.home, away: args.away, utcDate: new Date(args.kickoff).toISOString() });
    const text = JSON.stringify(report, null, 2);
    if (args.out) fs.writeFileSync(path.resolve(args.out), text, "utf8"); else console.log(text);
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
