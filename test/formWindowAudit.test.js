import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importHistoryMatches, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { dedupeContextMatches, mergeWithLocalHistory } from "../src/history/localHistory.js";
import { formModel } from "../src/engine/models.js";
import { auditFormWindow } from "../scripts/audit-form-window.js";

const KICKOFF = "2026-10-09T18:45:00Z";
const openDb = () => openHistoryDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fvm-form-")), "football.sqlite"));
let seq = 0;
function row({ source, home, away, playedAt, hg, ag, hid = null, aid = null }) {
  seq += 1;
  return {
    recordKey: `${source}:${seq}`, sourceFixtureId: String(seq), status: "FINISHED", sport: "FOOTBALL", playedAt,
    competition: { code: "DED", name: "Eredivisie", season: "2026" }, homeTeam: { id: hid, name: home }, awayTeam: { id: aid, name: away },
    score: { fullTime: { home: hg, away: ag } }, provenance: { source }, fetchedAt: "2026-10-01T00:00:00Z"
  };
}
const day = n => new Date(Date.parse("2026-09-01T18:45:00Z") + n * 86400_000).toISOString();

// PSV, newest first: W W W L W W W D (M2 is delivered by two providers under two spellings).
const RESULTS = [["W"], ["W", "dup"], ["W"], ["L"], ["W"], ["W"], ["W"], ["D"]];
function psvSeason() {
  const rows = [];
  RESULTS.forEach(([result, dup], index) => {
    const when = day(30 - index * 3);
    const [hg, ag] = result === "W" ? [2, 0] : result === "D" ? [1, 1] : [0, 1];
    rows.push(row({ source: "FOOTBALL_DATA", home: "PSV", away: `Rival${index}`, playedAt: when, hg, ag, hid: 674, aid: 900 + index }));
    if (dup) rows.push(row({ source: "API_FOOTBALL", home: "PSV Eindhoven", away: `Rival${index}`, playedAt: new Date(Date.parse(when) + 600_000).toISOString(), hg, ag, hid: 197, aid: 800 + index }));
  });
  for (let i = 0; i < 6; i += 1) rows.push(row({ source: "FOOTBALL_DATA", home: "SC Heerenveen", away: `Other${i}`, playedAt: day(25 - i * 3), hg: 1, ag: 1, hid: 675, aid: 700 + i }));
  return rows;
}
const FIXTURE = { home: "PSV Eindhoven", away: "Heerenveen", utcDate: KICKOFF };

test("PSV PPG 2.625 -> 2.375: one duplicated win leaves the last-8 window and an older draw enters", () => {
  const db = openDb();
  importHistoryMatches(db, psvSeason());
  const report = auditFormWindow(db, FIXTURE);
  const { BEFORE_PR5: before, PR5: pr5, CURRENT: current } = report.variants;
  assert.equal(before.home.points, 21);
  assert.equal(before.home.ppg, 2.625);
  assert.equal(before.home.matches.filter(match => match.groupSize > 1).length, 2, "the win appears twice in the window");
  assert.equal(pr5.home.ppg, 2.375);
  assert.equal(current.home.ppg, 2.375);
  assert.deepEqual(current.home.matches.map(match => match.result), ["W", "W", "W", "L", "W", "W", "W", "D"]);
  assert.equal(report.homeWindowChanges.addedByPR5.length, 1, "the 8th distinct match enters the window");
  assert.equal(report.variants.CURRENT.away.ppg, report.variants.BEFORE_PR5.away.ppg, "Heerenveen unchanged");
});

test("context merge: the same match from local history and the live provider is counted once, whichever spelling survives", () => {
  const external = { id: "af-1", utcDate: day(10), homeTeam: { id: -1, name: "PSV Eindhoven" }, awayTeam: { id: 5, name: "Rival" }, score: { fullTime: { home: 2, away: 0 } } };
  const local = { recordKey: "SQLITE:1", playedAt: new Date(Date.parse(day(10)) + 900_000).toISOString(), status: "FINISHED", competition: {}, homeTeam: { id: 674, name: "PSV" }, awayTeam: { id: 6, name: "Rival" }, score: { fullTime: { home: 2, away: 0 } }, provenance: { source: "FOOTBALL_DATA" } };
  const fixture = { home: "PSV Eindhoven", away: "Heerenveen", homeId: -1, awayId: -2, utcDate: KICKOFF };
  const withoutFix = mergeWithLocalHistory({ finished: [external] }, [local], fixture, { logicalDedupe: false });
  const withFix = mergeWithLocalHistory({ finished: [external] }, [local], fixture);
  assert.equal(withoutFix.finished.length, 2, "spelling-sensitive key kept both copies");
  assert.equal(withFix.finished.length, 1);
  assert.equal(withFix.finished[0].id, "af-1", "the live provider's row wins");
  const swapped = mergeWithLocalHistory({ finished: [] }, [local], fixture);
  assert.equal(swapped.finished.length, 1);
});

test("duplicates with disagreeing scores resolve deterministically in favour of the live provider", () => {
  const external = { id: "af-1", utcDate: day(10), homeTeam: { id: -1, name: "PSV Eindhoven" }, awayTeam: { id: 5, name: "Rival" }, score: { fullTime: { home: 2, away: 0 } } };
  const stale = { id: "SQLITE:1", utcDate: day(10), homeTeam: { id: -1, name: "PSV" }, awayTeam: { id: 5, name: "Rival" }, score: { fullTime: { home: 1, away: 1 } } };
  for (const input of [[stale, external], [external, stale]]) {
    const kept = dedupeContextMatches(input, rowItem => (rowItem === external ? 0 : 1));
    assert.deepEqual(kept.map(item => item.id), ["af-1"]);
  }
});

test("genuinely different matches are never collapsed (rematch, reversed fixture, other opponent)", () => {
  const make = (id, home, away, offset) => ({ id, utcDate: day(offset), homeTeam: { id: 1, name: home }, awayTeam: { id: 2, name: away }, score: { fullTime: { home: 1, away: 0 } } });
  const rows = [make("a", "PSV", "Heerenveen", 0), make("b", "PSV", "Heerenveen", 30), make("c", "Heerenveen", "PSV", 0.2), make("d", "PSV", "Ajax", 0)];
  assert.equal(dedupeContextMatches(rows).length, 4);
});

test("Form model is deterministic: same history and kickoff give the same output under any input order", () => {
  const db = openDb();
  importHistoryMatches(db, psvSeason());
  const report = auditFormWindow(db, FIXTURE);
  for (const variant of Object.values(report.variants)) assert.equal(variant.deterministicUnderReordering, true);
  const again = auditFormWindow(db, FIXTURE);
  assert.deepEqual(again.variants.CURRENT.form, report.variants.CURRENT.form);
  assert.deepEqual(again.variants.CURRENT.home.matches.map(match => match.id), report.variants.CURRENT.home.matches.map(match => match.id));
  const probability = formModel({ homeId: 1, awayId: 2 }, { finished: [] });
  assert.equal(probability, null);
});
