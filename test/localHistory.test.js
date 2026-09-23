import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLocalHistory, buildLocalHistoryContext, loadLocalHistory, mergeWithLocalHistory, normalizeHistoryMatch } from "../src/history/localHistory.js";
import { formModel, teamStrengthModel } from "../src/engine/models.js";
import { analyseFixture } from "../src/engine/analyse.js";
import { MIN_GAMES_FOR_MATURE_STANDINGS } from "../src/history/competitionBaseline.js";

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

// Forensic audit: Football-Data's own `fullTime` for a penalty-shootout match
// equals regularTime + penalties (confirmed on all 11 CLI shootout matches,
// e.g. LDU-Palmeiras: regularTime 3:2, penalties 3:4, fullTime 6:6) — not the
// 90-minute result standard 1X2/OU/AH markets settle on.
test("regularTime побеждает fullTime, когда серия пенальти отдаёт fullTime=regularTime+penalties",()=>{
  const row = normalizeHistoryMatch({
    id:576250,utcDate:"2026-09-16T22:00:00Z",homeTeam:{id:1,name:"LDU de Quito"},awayTeam:{id:2,name:"SE Palmeiras"},
    score:{duration:"REGULAR",winner:"DRAW",fullTime:{home:6,away:6},regularTime:{home:3,away:2},penalties:{home:3,away:4}}
  },"FOOTBALL_DATA");
  assert.deepEqual(row.score.fullTime,{home:3,away:2},"stored score must be the 90-minute regulation result, not fullTime+penalties");
});

test("обычный FT без regularTime сохраняет прежнее поведение (fallback на fullTime)",()=>{
  const row = normalizeHistoryMatch({
    id:2,utcDate:"2026-08-20T18:00:00Z",homeTeam:{id:1,name:"A"},awayTeam:{id:2,name:"B"},
    score:{fullTime:{home:2,away:1}}
  },"FOOTBALL_DATA");
  assert.deepEqual(row.score.fullTime,{home:2,away:1});
});

test("regularTime 0:0 используется корректно — не теряется из-за truthy/falsy 0",()=>{
  const row = normalizeHistoryMatch({
    id:3,utcDate:"2026-08-20T18:00:00Z",homeTeam:{id:1,name:"A"},awayTeam:{id:2,name:"B"},
    score:{duration:"PENALTY_SHOOTOUT",fullTime:{home:5,away:4},regularTime:{home:0,away:0},penalties:{home:5,away:4}}
  },"FOOTBALL_DATA");
  assert.deepEqual(row.score.fullTime,{home:0,away:0},"a genuine 0:0 regulation score must not be treated as \"missing\" and fall through to fullTime");
});

test("частичный/null regularTime -> fallback на fullTime (обе стороны должны быть валидны, иначе не доверяем)",()=>{
  const oneSideNull = normalizeHistoryMatch({
    id:4,utcDate:"2026-08-20T18:00:00Z",homeTeam:{id:1,name:"A"},awayTeam:{id:2,name:"B"},
    score:{fullTime:{home:3,away:2},regularTime:{home:3,away:null}}
  },"FOOTBALL_DATA");
  assert.deepEqual(oneSideNull.score.fullTime,{home:3,away:2});

  const noRegularTimeObject = normalizeHistoryMatch({
    id:5,utcDate:"2026-08-20T18:00:00Z",homeTeam:{id:1,name:"A"},awayTeam:{id:2,name:"B"},
    score:{fullTime:{home:1,away:1}}
  },"FOOTBALL_DATA");
  assert.deepEqual(noRegularTimeObject.score.fullTime,{home:1,away:1});
});

test("обычные результаты обычных лиг (без penalties) не меняются",()=>{
  const row = normalizeHistoryMatch({
    id:6,utcDate:"2026-08-20T18:00:00Z",homeTeam:{id:1,name:"Alpha"},awayTeam:{id:2,name:"Beta"},
    score:{winner:"HOME_TEAM",duration:"REGULAR",fullTime:{home:2,away:0},halfTime:{home:1,away:0}}
  },"FOOTBALL_DATA");
  assert.deepEqual(row.score.fullTime,{home:2,away:0});
});

// Confirmed (forensic audit, second contamination round): a knockout match
// decided in extra time WITHOUT a shootout has no `penalties` field at all,
// yet Football-Data's fullTime still includes the extra-time goals on top
// of the 90-minute score (e.g. Juventus-Galatasaray: fullTime 3:2,
// regularTime 3:0 -- 2 away goals scored in extra time). regularTime must
// win here too, exactly like the penalty-shootout case, since the check is
// "is regularTime present", not "are there penalties".
test("AET без серии пенальти (extraTime, но penalties отсутствует) -> тоже regularTime",()=>{
  const row = normalizeHistoryMatch({
    id:7,utcDate:"2026-02-25T20:00:00Z",homeTeam:{id:1,name:"Juventus FC"},awayTeam:{id:2,name:"Galatasaray SK"},
    score:{duration:"EXTRA_TIME",winner:"HOME_TEAM",fullTime:{home:3,away:2},regularTime:{home:3,away:0},extraTime:{home:0,away:2}}
  },"FOOTBALL_DATA");
  assert.deepEqual(row.score.fullTime,{home:3,away:0},"extra-time goals must not be counted into the stored regulation-time score either");
});

// API-Football's raw fixture objects have no `score.regularTime` field at
// all (a completely different shape: score.fulltime/extratime/penalty,
// lowercase, plus a top-level `goals` field) -- this fix must not affect
// them. Confirmed separately (forensic audit) that API-Football's own
// `goals` already excludes penalty-shootout goals, so the untouched
// fallback path (`match.score?.fullTime?.home ?? match.goals?.home`)
// remains correct and unaffected by this change.
test("API-Football semantics не затронуты — нет score.regularTime, используется существующий fallback на goals",()=>{
  const apiFootballShapedMatch={
    id:"1634050",utcDate:"2026-09-01T18:00:00Z",
    homeTeam:{id:9981,name:"Palmeiras W"},awayTeam:{id:16496,name:"Bahia W"},
    goals:{home:1,away:1},
    score:{halftime:{home:0,away:1},fulltime:{home:1,away:1},extratime:{home:null,away:null},penalty:{home:4,away:5}}
  };
  const row=normalizeHistoryMatch(apiFootballShapedMatch,"API_FOOTBALL");
  assert.deepEqual(row.score.fullTime,{home:1,away:1},"API-Football's own goals field (already penalty-exclusive) must be used unchanged, not score.fulltime/regularTime");
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

// Forensic audit fix (Seattle Sounders vs Real Salt Lake, 2026-09-24): the
// local-history fallback's HOME/AWAY split used to require only that each
// team had >=4 games OVERALL (any venue) and >=1 game AT the relevant venue
// -- neither actually bounds how thin the venue-SPECIFIC sample can be.
// These tests reuse the exact same MIN_GAMES_FOR_MATURE_STANDINGS constant
// and principle competitionBaseline.js's hasMatureVenueSplits already
// enforces for the SQLite tier, now mirrored here.
const SEATTLE = { homeId: 10, home: "Seattle Sounders", awayId: 20, away: "Real Salt Lake", utcDate: "2026-09-24T01:30:00Z" };

function homeVenueRow(homeId, homeName, awayId, awayName, n, kickoffPrefix) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(match(`h${kickoffPrefix}${i}`, `2026-08-${10 + i}T18:00:00Z`, homeId, homeName, 900 + i, `Opp${i}`, i === 0 ? 0 : 1, i === 0 ? 0 : 2));
  return rows;
}
function awayVenueRow(homeId, homeName, awayId, awayName, n, kickoffPrefix) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(match(`a${kickoffPrefix}${i}`, `2026-08-${10 + i}T20:00:00Z`, 900 + i, `Opp${i}`, awayId, awayName, 2, 1));
  return rows;
}

test("Home имеет 1 HOME матч (0:0) но >=4 матчей overall -> venue split НЕ зрелый (Seattle-shaped)", () => {
  // Seattle: 1 HOME match (0:0) + 3 AWAY matches = 4 overall (clears the old
  // homeRows.length>=4 gate). Real Salt Lake: 2 HOME + 2 AWAY = 4 overall,
  // giving RSL a HOME-venue row too so the OLD gate's home.length===2 check
  // would ALSO have passed -- proving this is a genuine behavior change, not
  // an accidental side effect of RSL lacking any home row.
  const seattle = [
    ...homeVenueRow(SEATTLE.homeId, SEATTLE.home, null, null, 1, "s"),
    ...awayVenueRow(null, null, SEATTLE.homeId, SEATTLE.home, 3, "s")
  ];
  const rsl = [
    ...homeVenueRow(SEATTLE.awayId, SEATTLE.away, null, null, 2, "r"),
    ...awayVenueRow(null, null, SEATTLE.awayId, SEATTLE.away, 2, "r")
  ];
  const rows = [...seattle, ...rsl].map(m => normalizeHistoryMatch(m, "API_FOOTBALL"));
  const context = buildLocalHistoryContext(rows, SEATTLE);

  assert.equal(context.contextMeta.homeMatches, 4);
  assert.equal(context.contextMeta.homeVenueMatches, 1, "Seattle's own HOME-venue sample is exactly the one 0:0 game");
  assert.equal(context.contextMeta.venueSplitMature, false);
  assert.equal(context.standings.standings.some(g => g.type === "HOME"), false, "an immature venue split must not be published at all");
  assert.equal(context.standings.standings.some(g => g.type === "AWAY"), false);
  assert.equal(context.standings.standings.find(g => g.type === "TOTAL").table.length, 2, "TOTAL (the safe fallback teamStrengthModel already knows how to use) must still be present");
});

test("Away имеет 1 AWAY матч но >=4 матчей overall -> venue split НЕ зрелый (симметрично)", () => {
  const seattle = [
    ...homeVenueRow(SEATTLE.homeId, SEATTLE.home, null, null, 2, "s"),
    ...awayVenueRow(null, null, SEATTLE.homeId, SEATTLE.home, 2, "s")
  ];
  const rsl = [
    ...homeVenueRow(SEATTLE.awayId, SEATTLE.away, null, null, 3, "r"),
    ...awayVenueRow(null, null, SEATTLE.awayId, SEATTLE.away, 1, "r")
  ];
  const rows = [...seattle, ...rsl].map(m => normalizeHistoryMatch(m, "API_FOOTBALL"));
  const context = buildLocalHistoryContext(rows, SEATTLE);

  assert.equal(context.contextMeta.awayVenueMatches, 1);
  assert.equal(context.contextMeta.venueSplitMature, false);
  assert.equal(context.standings.standings.some(g => g.type === "HOME" || g.type === "AWAY"), false);
});

test(`ровно ${MIN_GAMES_FOR_MATURE_STANDINGS} HOME + ${MIN_GAMES_FOR_MATURE_STANDINGS} AWAY -> зрелый, split публикуется (та же константа что и competition baseline)`, () => {
  // Each team also gets exactly one appearance at the OTHER venue, purely so
  // the pre-existing home.length===2/away.length===2 presence check (which
  // this fix does not touch) has a row to rank for the opponent side too --
  // the maturity bar under test is the *depth* at each team's OWN relevant
  // venue: Seattle's HOME games and RSL's AWAY games, exactly at the
  // MIN_GAMES_FOR_MATURE_STANDINGS boundary.
  const seattle = [
    ...homeVenueRow(SEATTLE.homeId, SEATTLE.home, null, null, MIN_GAMES_FOR_MATURE_STANDINGS, "s"),
    ...awayVenueRow(null, null, SEATTLE.homeId, SEATTLE.home, 1, "s2")
  ];
  const rsl = [
    ...awayVenueRow(null, null, SEATTLE.awayId, SEATTLE.away, MIN_GAMES_FOR_MATURE_STANDINGS, "r"),
    ...homeVenueRow(SEATTLE.awayId, SEATTLE.away, null, null, 1, "r2")
  ];
  const rows = [...seattle, ...rsl].map(m => normalizeHistoryMatch(m, "API_FOOTBALL"));
  const context = buildLocalHistoryContext(rows, SEATTLE);

  assert.equal(context.contextMeta.homeVenueMatches, MIN_GAMES_FOR_MATURE_STANDINGS);
  assert.equal(context.contextMeta.awayVenueMatches, MIN_GAMES_FOR_MATURE_STANDINGS);
  assert.equal(context.contextMeta.venueSplitMature, true);
  assert.equal(context.standings.standings.some(g => g.type === "HOME"), true);
  assert.equal(context.standings.standings.some(g => g.type === "AWAY"), true);
});

test("достаточно overall (6 каждый), но venue-специфично недостаточно (3 каждый) -> split НЕ допускается", () => {
  const seattle = [
    ...homeVenueRow(SEATTLE.homeId, SEATTLE.home, null, null, 3, "s"),
    ...awayVenueRow(null, null, SEATTLE.homeId, SEATTLE.home, 3, "s2")
  ];
  const rsl = [
    ...homeVenueRow(SEATTLE.awayId, SEATTLE.away, null, null, 3, "r"),
    ...awayVenueRow(null, null, SEATTLE.awayId, SEATTLE.away, 3, "r2")
  ];
  const rows = [...seattle, ...rsl].map(m => normalizeHistoryMatch(m, "API_FOOTBALL"));
  const context = buildLocalHistoryContext(rows, SEATTLE);

  assert.equal(context.contextMeta.homeMatches, 6);
  assert.equal(context.contextMeta.awayMatches, 6);
  assert.equal(context.contextMeta.homeVenueMatches, 3);
  assert.equal(context.contextMeta.awayVenueMatches, 3);
  assert.equal(context.contextMeta.venueSplitMature, false, "3 < MIN_GAMES_FOR_MATURE_STANDINGS(4) even though overall counts look generous");
});

test("существующий mature local-history сценарий не ломается: genuine split still feeds teamStrengthModel with real venue-specific λ", () => {
  const seattle = homeVenueRow(SEATTLE.homeId, SEATTLE.home, null, null, MIN_GAMES_FOR_MATURE_STANDINGS, "s");
  const rsl = awayVenueRow(null, null, SEATTLE.awayId, SEATTLE.away, MIN_GAMES_FOR_MATURE_STANDINGS, "r");
  const rows = [...seattle, ...rsl].map(m => normalizeHistoryMatch(m, "API_FOOTBALL"));
  const context = buildLocalHistoryContext(rows, SEATTLE);
  const strength = teamStrengthModel(SEATTLE, context);
  assert.ok(strength, "a genuinely mature venue split must still produce a Team Strength estimate");
  assert.ok(Number.isFinite(strength.lambdas.home) && Number.isFinite(strength.lambdas.away));
});

test("Seattle/RSL-подобный кейс больше не может получить λ из одной домашней игры: teamStrengthModel falls back to TOTAL instead of collapsing to the floor", () => {
  // Same shape as the real forensic case: Seattle's ONLY home game is 0:0,
  // but Seattle has a healthy overall scoring record (6 GF/5 GA across 4
  // games) once the venue split is correctly excluded and TOTAL is used
  // instead (models.js's own existing `homeH = row(homeTable,...) ||
  // totalH` fallback -- unmodified).
  const seattleHome0_0 = match("s-home", "2026-09-06T00:30:00Z", SEATTLE.homeId, SEATTLE.home, 901, "NYRB", 0, 0);
  const seattleAway1 = match("s-away1", "2026-09-10T18:00:00Z", 902, "OppA", SEATTLE.homeId, SEATTLE.home, 2, 1);
  const seattleAway2 = match("s-away2", "2026-09-14T18:00:00Z", 903, "OppB", SEATTLE.homeId, SEATTLE.home, 1, 3);
  const seattleAway3 = match("s-away3", "2026-09-18T18:00:00Z", 904, "OppC", SEATTLE.homeId, SEATTLE.home, 2, 2);
  const rslHome = match("r-home", "2026-09-06T01:30:00Z", SEATTLE.awayId, SEATTLE.away, 905, "OppD", 1, 1);
  const rslAway1 = match("r-away1", "2026-09-01T18:00:00Z", 906, "OppE", SEATTLE.awayId, SEATTLE.away, 1, 2);
  const rslAway2 = match("r-away2", "2026-08-30T01:30:00Z", 907, "OppF", SEATTLE.awayId, SEATTLE.away, 0, 1);
  const rslAway3 = match("r-away3", "2026-08-26T02:30:00Z", 908, "OppG", SEATTLE.awayId, SEATTLE.away, 2, 2);
  const rslAway4 = match("r-away4", "2026-08-22T02:30:00Z", 909, "OppH", SEATTLE.awayId, SEATTLE.away, 1, 0);
  const rows = [seattleHome0_0, seattleAway1, seattleAway2, seattleAway3, rslHome, rslAway1, rslAway2, rslAway3, rslAway4].map(m => normalizeHistoryMatch(m, "API_FOOTBALL"));

  const context = buildLocalHistoryContext(rows, SEATTLE);
  assert.equal(context.contextMeta.homeVenueMatches, 1);
  assert.equal(context.contextMeta.venueSplitMature, false);
  assert.equal(context.standings.standings.some(g => g.type === "HOME"), false);

  const strength = teamStrengthModel(SEATTLE, context);
  assert.ok(strength, "TOTAL-based fallback still has enough overall data to produce an estimate");
  assert.ok(strength.lambdas.home > 0.5, `lambdaHome must reflect Seattle's real overall scoring record (6 GF/4 games), not collapse to the 0.25 floor from one 0:0 home game -- got ${strength.lambdas.home}`);
});

test("temporal-safe сохраняется: матч на/после kickoff не учитывается ни в overall, ни в venue-зрелости", () => {
  const seattle = homeVenueRow(SEATTLE.homeId, SEATTLE.home, null, null, MIN_GAMES_FOR_MATURE_STANDINGS, "s");
  const rsl = awayVenueRow(null, null, SEATTLE.awayId, SEATTLE.away, MIN_GAMES_FOR_MATURE_STANDINGS, "r");
  const futureHome = match("future-home", "2026-09-25T18:00:00Z", SEATTLE.homeId, SEATTLE.home, 999, "Future", 5, 0);
  const rows = [...seattle, ...rsl, futureHome].map(m => normalizeHistoryMatch(m, "API_FOOTBALL"));
  const context = buildLocalHistoryContext(rows, SEATTLE);

  assert.equal(context.contextMeta.homeVenueMatches, MIN_GAMES_FOR_MATURE_STANDINGS, "a match at/after kickoff must not inflate the venue-maturity count");
  assert.equal(context.contextMeta.temporalSafe, true);
});
