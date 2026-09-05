import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openHistoryDatabase, importHistoryMatches } from "../src/history/sqliteHistory.js";
import { buildCompetitionBaseline, baselineCoversFixture } from "../src/history/competitionBaseline.js";
import { alignContextTeamIds } from "../src/engine/contextIds.js";

function tempDb(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-baseline-")),"football.sqlite");}
function match({id,competitionCode="PL",season="2025",playedAt,home,homeId,away,awayId,hg=1,ag=0}){
  return {recordKey:`FOOTBALL_DATA:${id}`,sourceFixtureId:id,playedAt,status:"FINISHED",sport:"FOOTBALL",
    competition:{code:competitionCode,name:competitionCode,season},
    homeTeam:{id:homeId,name:home},awayTeam:{id:awayId,name:away},
    score:{fullTime:{home:hg,away:ag}},provenance:{source:"FOOTBALL_DATA"},fetchedAt:playedAt};
}

function seedFourTeamSeason(db,{competitionCode="PL",season="2025",datePrefix="2025-09"}={}){
  importHistoryMatches(db,[
    match({id:`${season}-1`,competitionCode,season,playedAt:`${datePrefix}-01T18:00:00Z`,home:"Alpha",homeId:"1",away:"Beta",awayId:"2",hg:2,ag:1}),
    match({id:`${season}-2`,competitionCode,season,playedAt:`${datePrefix}-05T18:00:00Z`,home:"Gamma",homeId:"3",away:"Delta",awayId:"4",hg:0,ag:0}),
    match({id:`${season}-3`,competitionCode,season,playedAt:`${datePrefix}-08T18:00:00Z`,home:"Beta",homeId:"2",away:"Gamma",awayId:"3",hg:3,ag:1})
  ]);
}

test("competition-wide baseline is built from all teams, not the two fixture teams",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db);
  const baseline=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.equal(baseline.baselineSource,"CURRENT_SEASON");
  const total=baseline.standings.standings.find(s=>s.type==="TOTAL").table;
  assert.equal(total.length,4,"all four teams must appear, not just two");
  assert.equal(baseline.baselineTeams,4);
  assert.equal(baseline.baselineSample,3);
  db.close();
});

test("previous season is used only as a distinct fallback tier, never blended with current season",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"});
  // current season (2025) has only the two fixture teams so far — same
  // breadth as the old two-team fallback, so the genuine previous-season
  // baseline should win instead.
  importHistoryMatches(db,[match({id:"2025-thin",competitionCode:"PL",season:"2025",playedAt:"2025-08-20T18:00:00Z",home:"Alpha",homeId:"1",away:"Beta",awayId:"2"})]);
  const baseline=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.equal(baseline.baselineSource,"PREVIOUS_SEASON");
  assert.equal(baseline.sampleCurrentSeason,1);
  assert.equal(baseline.samplePreviousSeason,3);
  const total=baseline.standings.standings.find(s=>s.type==="TOTAL").table;
  assert.equal(total.length,4);
  db.close();
});

test("competition isolation: one competition's baseline never includes another competition's teams",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{competitionCode:"PL"});
  seedFourTeamSeason(db,{competitionCode:"SA",datePrefix:"2025-09"});
  importHistoryMatches(db,[match({id:"sa-extra",competitionCode:"SA",season:"2025",playedAt:"2025-09-09T18:00:00Z",home:"Zulu",homeId:"9",away:"Omega",awayId:"8"})]);
  const pl=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  const names=pl.standings.standings.find(s=>s.type==="TOTAL").table.map(row=>row.team.name);
  assert.ok(!names.includes("Zulu")&&!names.includes("Omega"),"SA-only teams must not leak into PL's baseline");
  db.close();
});

test("temporal safety: matches at or after the fixture kickoff are never included",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db);
  importHistoryMatches(db,[match({id:"future",competitionCode:"PL",season:"2025",playedAt:"2025-09-20T18:00:00Z",home:"Alpha",homeId:"1",away:"Delta",awayId:"4",hg:9,ag:0})]);
  const baseline=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  const alpha=baseline.standings.standings.find(s=>s.type==="TOTAL").table.find(row=>row.team.name==="Alpha");
  assert.equal(alpha.playedGames,1,"the 2025-09-20 match is after the fixture's own kickoff and must not count");
  db.close();
});

test("a promoted team absent from last season's competition table does not break the baseline or masquerade as history",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // Alpha/Beta/Gamma/Delta played PL last season
  // "Epsilon" is newly promoted this season and has zero PL history of any season.
  importHistoryMatches(db,[match({id:"promoted",competitionCode:"PL",season:"2025",playedAt:"2025-08-20T18:00:00Z",home:"Alpha",homeId:"1",away:"Epsilon",awayId:"5"})]);
  const baseline=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.equal(baseline.baselineSource,"PREVIOUS_SEASON");
  const names=baseline.standings.standings.find(s=>s.type==="TOTAL").table.map(row=>row.team.name);
  assert.ok(!names.includes("Epsilon"),"a team with no previous-season row must not be fabricated into the previous-season baseline");
  assert.ok(names.includes("Alpha")&&names.includes("Beta"),"the teams that genuinely have previous-season history must still be present");
  db.close();
});

test("baselineCoversFixture rejects a foreign provider's numeric team id that coincidentally collides with the fixture's own id",()=>{
  const db=openHistoryDatabase(tempDb());
  // Neither "Hull City" nor "Aston Villa" is in this baseline — the two teams
  // that ARE in it happen to carry the source provider's own numeric ids "64"
  // and "66", which coincidentally equal this fixture's API-Football
  // homeId/awayId as plain numbers.
  seedFourTeamSeason(db,{competitionCode:"PL"});
  const baseline=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  const fixture={id:"hull-villa",home:"Hull City",away:"Aston Villa",homeId:1,awayId:2,utcDate:"2025-09-10T16:00:00Z"};
  // Force the collision deliberately: relabel one genuine row's id to the
  // exact (numeric) homeId of a team that is NOT actually in this table.
  const collided=JSON.parse(JSON.stringify(baseline.standings));
  collided.standings.find(s=>s.type==="TOTAL").table[0].team.id=fixture.homeId; // still a plain number after JSON round-trip, unmatched by name
  assert.equal(baselineCoversFixture(collided,fixture),false,
    "a same-typed but unmatched id must not be accepted as coverage — only alignContextTeamIds's own reassignment should produce a true match");

  const aligned=alignContextTeamIds({standings:baseline.standings,finished:[],scheduled:[]},fixture);
  assert.equal(baselineCoversFixture(aligned.standings,fixture),false,
    "alignContextTeamIds correctly leaves unmatched rows alone — coverage must be false when the fixture's real teams are absent from the baseline");
  db.close();
});

test("baselineCoversFixture is true once alignContextTeamIds has genuinely matched both fixture teams by name",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db); // Alpha/Beta/Gamma/Delta
  const baseline=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  const fixture={id:"alpha-beta",home:"Alpha",away:"Beta",homeId:101,awayId:102,utcDate:"2025-09-10T16:00:00Z"};
  const aligned=alignContextTeamIds({standings:baseline.standings,finished:[],scheduled:[]},fixture);
  assert.equal(baselineCoversFixture(aligned.standings,fixture),true);
  db.close();
});

test("insufficient data on both tiers is reported explicitly, never silently as a league average",()=>{
  const db=openHistoryDatabase(tempDb());
  importHistoryMatches(db,[match({id:"only-pair",competitionCode:"ELC",season:"2025",playedAt:"2025-09-01T18:00:00Z",home:"Alpha",homeId:"1",away:"Beta",awayId:"2"})]);
  const baseline=buildCompetitionBaseline(db,"ELC","2025","2025-09-10T00:00:00Z");
  assert.equal(baseline.baselineSource,"INSUFFICIENT");
  assert.equal(baseline.standings,null);
  db.close();
});
