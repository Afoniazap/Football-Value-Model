import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLocalHistory, buildLocalHistoryContext, loadLocalHistory, mergeWithLocalHistory, normalizeHistoryMatch } from "../src/history/localHistory.js";
import { formModel } from "../src/engine/models.js";
import { analyseFixture } from "../src/engine/analyse.js";

function match(id, date, homeId, home, awayId, away, hg = 1, ag = 0) {
  return { id, utcDate: date, leagueId: 1, league: "Real League", season: 2026, homeTeam: { id: homeId, name: home }, awayTeam: { id: awayId, name: away }, score: { fullTime: { home: hg, away: ag } } };
}

test("append-only история сохраняет provenance и не дублирует fixture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-history-"));
  const file = path.join(dir, "fixtures.jsonl");
  const row = match(7, "2026-08-20T18:00:00Z", 1, "Home", 2, "Away");
  assert.equal(appendLocalHistory(file, [row], "API_FOOTBALL", "2026-08-21T00:00:00Z"), 1);
  assert.equal(appendLocalHistory(file, [row], "API_FOOTBALL", "2026-08-22T00:00:00Z"), 0);
  const loaded = loadLocalHistory(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].provenance.source, "API_FOOTBALL");
  assert.equal(loaded[0].fetchedAt, "2026-08-21T00:00:00.000Z");
});

test("неполный результат не превращается в нули", () => {
  assert.equal(normalizeHistoryMatch({ id: 1, utcDate: "2026-08-20T18:00:00Z", homeTeam: { id: 1, name: "A" }, awayTeam: { id: 2, name: "B" }, score: { fullTime: { home: null, away: null } } }, "API_FOOTBALL"), null);
});

test("локальный context использует разные соревнования и только матчи до kickoff", () => {
  const fixture = { homeId: 10, home: "Alpha FC", awayId: 20, away: "Beta", utcDate: "2026-08-27T18:00:00Z" };
  const rows = [];
  for (let index = 0; index < 5; index++) {
    rows.push(normalizeHistoryMatch(match(`h${index}`, `2026-08-${10 + index}T18:00:00Z`, 10, "Alpha", 100 + index, `H${index}`, 2, 1), "API_FOOTBALL"));
    rows.push(normalizeHistoryMatch(match(`a${index}`, `2026-08-${10 + index}T20:00:00Z`, 200 + index, `A${index}`, 20, "Beta", 0, 1), "API_FOOTBALL"));
  }
  rows.push(normalizeHistoryMatch(match("future", "2026-08-28T18:00:00Z", 10, "Alpha", 20, "Beta", 9, 9), "API_FOOTBALL"));
  const context = buildLocalHistoryContext(rows, fixture);
  assert.equal(context.contextMeta.homeMatches, 5);
  assert.equal(context.contextMeta.awayMatches, 5);
  assert.equal(context.finished.length, 10);
  assert.equal(context.contextMeta.temporalSafe, true);
  assert.equal(context.standings.standings.find(group => group.type === "TOTAL").table.length, 2);
});

test("имена других провайдеров сопоставляются без подмены provider ID", () => {
  const fixture = { homeId: 10, home: "FC Alpha", awayId: 20, away: "Beta CF", utcDate: "2026-08-27T18:00:00Z" };
  const rows = [normalizeHistoryMatch(match(1, "2026-08-20T18:00:00Z", 999, "Alpha", 888, "Opponent"), "FOOTBALL_DATA")];
  const context = buildLocalHistoryContext(rows, fixture);
  assert.equal(context.contextMeta.homeMatches, 1);
  assert.deepEqual(context.contextMeta.provenance, ["FOOTBALL_DATA"]);
});

test("backfilled provider IDs are aligned for Recent Form after confirmed identity matching", () => {
  const fixture = { homeId: 10, home: "FC Alpha", awayId: 20, away: "Beta CF", utcDate: "2026-08-27T18:00:00Z" };
  const rows = [];
  for (let index = 0; index < 4; index++) {
    rows.push(normalizeHistoryMatch(match(`h${index}`, `2026-08-${10 + index}T18:00:00Z`, 900 + index, "Alpha", 100 + index, `H${index}`, 2, 1), "FOOTBALL_DATA"));
    rows.push(normalizeHistoryMatch(match(`a${index}`, `2026-08-${10 + index}T20:00:00Z`, 200 + index, `A${index}`, 800 + index, "Beta", 0, 1), "FOOTBALL_DATA"));
  }
  const context = buildLocalHistoryContext(rows, fixture);
  assert.equal(context.finished.filter(row => row.homeTeam.id === fixture.homeId || row.awayTeam.id === fixture.homeId).length, 4);
  assert.equal(context.finished.filter(row => row.homeTeam.id === fixture.awayId || row.awayTeam.id === fixture.awayId).length, 4);
  assert.ok(formModel(fixture, context));
  const analysis=analyseFixture(fixture,context,null,{minDataQuality:70,minEdge:4,minEv:5,minConfidence:70,minStability:70});
  assert.equal(analysis.dataQualityV2.formScore,15);
  assert.ok(analysis.consensusProbability);
  assert.equal(analysis.marketAvailable,false);
  assert.equal(analysis.best,null);
  assert.equal(analysis.category,"WAIT");
});

test("один матч из local history и provider context не удваивается", () => {
  const fixture = { homeId: 10, home: "Alpha", awayId: 20, away: "Beta", utcDate: "2026-08-27T18:00:00Z" };
  const raw = match(7, "2026-08-20T18:00:00Z", 10, "Alpha", 30, "Opponent");
  const local = [normalizeHistoryMatch(raw, "API_FOOTBALL")];
  const merged = mergeWithLocalHistory({ standings: null, finished: [raw], scheduled: [] }, local, fixture);
  assert.equal(merged.finished.length, 1);
  assert.equal(merged.standings, null);
});

test("один матч от двух провайдеров остаётся одной logical record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-history-cross-source-"));
  const file = path.join(dir, "fixtures.jsonl");
  const row = match(7, "2026-08-20T18:00:00Z", 1, "FC Alpha", 2, "Beta", 2, 1);
  appendLocalHistory(file, [row], "API_FOOTBALL");
  appendLocalHistory(file, [{ ...row, id: 900, homeTeam: { id: 100, name: "Alpha" } }], "FOOTBALL_DATA");
  const loaded = loadLocalHistory(file);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].provenance.sources.sort(), ["API_FOOTBALL", "FOOTBALL_DATA"]);
});

test("TheSportsDB identity evidence excludes a same-name team from another sport",()=>{
  const fixture={homeId:567,home:"Plzen",awayId:20,away:"Beta",utcDate:"2026-08-27T18:00:00Z"};
  const hockey=normalizeHistoryMatch(match("hockey","2026-08-20T18:00:00Z","140877","Plzen","2","Sparta",2,1),"THESPORTSDB");
  const football=normalizeHistoryMatch(match("football","2026-08-21T18:00:00Z","134015","Viktoria Plzeň","3","Slavia",1,0),"THESPORTSDB");
  const context=buildLocalHistoryContext([hockey,football],fixture);
  assert.equal(context.contextMeta.homeMatches,1);
});

test("TheSportsDB evidence excludes handball Ferencvarosi from football history",()=>{
  const fixture={homeId:651,home:"Ferencvarosi TC",awayId:20,away:"Beta",utcDate:"2026-08-27T18:30:00Z"};
  const handball=normalizeHistoryMatch(match("handball","2026-08-20T18:00:00Z","137581","Ferencvárosi TC","2","Szigetszentmiklos",2,1),"THESPORTSDB");
  const football=normalizeHistoryMatch(match("football","2026-08-21T18:00:00Z","134620","Ferencváros","3","Ujpest",1,0),"THESPORTSDB");
  assert.equal(buildLocalHistoryContext([handball,football],fixture).contextMeta.homeMatches,1);
});
