import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalTeamIdentity, canonicalTeamName, sameTeamIdentity } from "../src/history/teamAliases.js";
import { dedupeLogicalMatches, findLogicalDuplicates, getTeamLastMatches, importHistoryMatches, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { dedupeContextMatches } from "../src/history/localHistory.js";
import { isSameLogicalMatch, matchSignature } from "../src/history/logicalMatch.js";
import { auditFormWindow } from "../scripts/audit-form-window.js";

const KICKOFF = "2026-10-09T18:45:00Z";
const openDb = () => openHistoryDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-spell-")), "football.sqlite"));
let seq = 0;
function row({ source, home, away, playedAt, hg, ag, hid = null, aid = null }) {
  seq += 1;
  return {
    recordKey: `${source}:${seq}`, sourceFixtureId: String(seq), status: "FINISHED", sport: "FOOTBALL", playedAt,
    competition: { code: "DED", name: "Eredivisie", season: "2026" }, homeTeam: { id: hid, name: home }, awayTeam: { id: aid, name: away },
    score: { fullTime: { home: hg, away: ag } }, provenance: { source }, fetchedAt: "2026-10-01T00:00:00Z"
  };
}
const day = n => new Date(Date.parse("2026-08-01T16:30:00Z") + n * 86400_000).toISOString();

test("Willem II / Willem II Tilburg: canonical keys never met; Heerenveen spellings did", () => {
  assert.equal(canonicalTeamName("Willem II"), "willem ii");
  assert.equal(canonicalTeamName("Willem II Tilburg"), "willem ii tilburg");
  assert.equal(canonicalTeamName("Heerenveen"), canonicalTeamName("SC Heerenveen"));
  assert.equal(canonicalTeamIdentity("Willem II"), canonicalTeamIdentity("Willem II Tilburg"), "curated alias now unifies them");
  assert.equal(sameTeamIdentity("Willem II Tilburg", "Willem II"), true);
  assert.equal(sameTeamIdentity("Willem II", "Willem III"), false);
});

// Heerenveen, newest first: W D(Willem II 2:2, stored twice) L W W D L W | older: D.
const RESULTS = [[2, 0], [2, 2, "dup"], [0, 1], [3, 0], [1, 0], [1, 1], [0, 2], [2, 1], [1, 1]];
function heerenveenSeason(opponentSpellings) {
  const rows = [];
  RESULTS.forEach(([hg, ag, dup], index) => {
    const when = day(40 - index * 4);
    // Heerenveen is the away side in every fixture
    rows.push(row({ source: "API_FOOTBALL", home: opponentSpellings[0].replace("{i}", index), away: "Heerenveen", playedAt: when, hg: ag, ag: hg, hid: 100 + index, aid: 210 }));
    if (dup) rows.push(row({ source: "FOOTBALL_DATA", home: opponentSpellings[1].replace("{i}", index), away: "SC Heerenveen", playedAt: new Date(Date.parse(when) + 420_000).toISOString(), hg: ag, ag: hg, hid: 300 + index, aid: 675 }));
  });
  for (let i = 0; i < 6; i += 1) rows.push(row({ source: "FOOTBALL_DATA", home: "PSV", away: `Opp${i}`, playedAt: day(30 - i * 3), hg: 2, ag: 0, hid: 674, aid: 900 + i }));
  return rows;
}

test("the 30.08 duplicate (Willem II / Willem II Tilburg, 2:2) is one match in the Heerenveen window", () => {
  const db = openDb();
  // the duplicated match is index 1: opponent spelled "Willem II" by API-Football and "Willem II Tilburg" by Football-Data
  const rows = heerenveenSeason(["Rival{i}", "Rival{i}"]).map(entry => {
    if (entry.homeTeam.name === "Rival1") return { ...entry, homeTeam: { ...entry.homeTeam, name: entry.provenance.source === "API_FOOTBALL" ? "Willem II" : "Willem II Tilburg" } };
    return entry;
  });
  importHistoryMatches(db, rows);
  const found = getTeamLastMatches(db, { name: "Heerenveen" }, KICKOFF, 20);
  assert.equal(found.length, 9, "9 real matches, not 10");
  const report = auditFormWindow(db, { home: "PSV", away: "Heerenveen", utcDate: KICKOFF });
  const before = report.variants.BEFORE_PR5.away, current = report.variants.CURRENT.away;
  assert.equal(before.matches.filter(match => match.groupSize === 2).length, 2, "the 2:2 draw sits twice in the old window");
  assert.equal(current.matches.filter(match => match.groupSize > 1).length, 0);
  // old window: W D D L W W D L = 3+1+1+0+3+3+1+0 = 12 ; new window: W D L W W D L W = 3+1+0+3+3+1+0+3 = 14
  assert.equal(before.points, 12);
  assert.equal(current.points, 14);
  assert.deepEqual(current.matches.map(match => match.result), ["W", "D", "L", "W", "W", "D", "L", "W"]);
});

test("a spelling variant with no alias is still one match: same club, same side, same score, same moment", () => {
  const make = (id, home, away, hg, ag, offsetMin, source) => ({
    recordKey: `${source}:${id}`, playedAt: new Date(Date.parse("2026-08-30T16:30:00Z") + offsetMin * 60_000).toISOString(),
    homeTeam: { name: home }, awayTeam: { name: away }, score: { fullTime: { home: hg, away: ag } }, provenance: { source }
  });
  const pair = [make(1, "Delta Rovers", "Heerenveen", 2, 2, 0, "API_FOOTBALL"), make(2, "Delta Rovers Utrecht", "SC Heerenveen", 2, 2, 7, "FOOTBALL_DATA")];
  assert.equal(isSameLogicalMatch(matchSignature(pair[0]), matchSignature(pair[1])), true);
  assert.equal(dedupeLogicalMatches(pair).length, 1);
  assert.equal(findLogicalDuplicates(pair).length, 1);
  assert.equal(findLogicalDuplicates(pair)[0].rows[0].score, "2:2");
  // context-shaped rows (utcDate/id) behave the same
  const context = pair.map(entry => ({ id: entry.recordKey, utcDate: entry.playedAt, homeTeam: entry.homeTeam, awayTeam: entry.awayTeam, score: entry.score }));
  assert.equal(dedupeContextMatches(context).length, 1);
});

test("different score, unrelated opponent, other side or another day are never merged", () => {
  const make = (id, home, away, hg, ag, offsetMin) => ({
    recordKey: `S:${id}`, playedAt: new Date(Date.parse("2026-08-30T16:30:00Z") + offsetMin * 60_000).toISOString(),
    homeTeam: { name: home }, awayTeam: { name: away }, score: { fullTime: { home: hg, away: ag } }, provenance: { source: "S" }
  });
  const base = make(1, "Delta Rovers", "Heerenveen", 2, 2, 0);
  const sig = matchSignature(base);
  assert.equal(isSameLogicalMatch(sig, matchSignature(make(2, "Delta Rovers Utrecht", "Heerenveen", 3, 1, 5))), false, "score conflict stays visible");
  assert.equal(isSameLogicalMatch(sig, matchSignature(make(3, "Ajax", "Heerenveen", 2, 2, 5))), false, "unrelated opponent");
  assert.equal(isSameLogicalMatch(sig, matchSignature(make(4, "Heerenveen", "Delta Rovers Utrecht", 2, 2, 5))), false, "other side");
  assert.equal(isSameLogicalMatch(sig, matchSignature(make(5, "Delta Rovers Utrecht", "Heerenveen", 2, 2, 24 * 60))), false, "another day");
  assert.equal(dedupeLogicalMatches([base, make(6, "Delta Rovers", "Heerenveen", 2, 2, 20 * 24 * 60)]).length, 2, "rematch weeks later");
});
