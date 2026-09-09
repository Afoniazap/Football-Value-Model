import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openHistoryDatabase, importHistoryMatches } from "../src/history/sqliteHistory.js";
import { buildCompetitionBaseline, baselineCoversFixture, pickCompetitionBaseline, resolveTeamStrengthBaseline } from "../src/history/competitionBaseline.js";
import { alignContextTeamIds } from "../src/engine/contextIds.js";
import { mergeWithLocalHistory } from "../src/history/localHistory.js";
import { teamStrengthModel } from "../src/engine/models.js";

function tempDb(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-baseline-")),"football.sqlite");}
function match({id,competitionCode="PL",season="2025",playedAt,home,homeId,away,awayId,hg=1,ag=0}){
  return {recordKey:`FOOTBALL_DATA:${id}`,sourceFixtureId:id,playedAt,status:"FINISHED",sport:"FOOTBALL",
    competition:{code:competitionCode,name:competitionCode,season},
    homeTeam:{id:homeId,name:home},awayTeam:{id:awayId,name:away},
    score:{fullTime:{home:hg,away:ag}},provenance:{source:"FOOTBALL_DATA"},fetchedAt:playedAt};
}

function seedFourTeamSeason(db,{competitionCode="PL",season="2025",datePrefix="2025-09"}={}){
  importHistoryMatches(db,[
    match({id:`${season}-${competitionCode}-1`,competitionCode,season,playedAt:`${datePrefix}-01T18:00:00Z`,home:"Alpha",homeId:"1",away:"Beta",awayId:"2",hg:2,ag:1}),
    match({id:`${season}-${competitionCode}-2`,competitionCode,season,playedAt:`${datePrefix}-05T18:00:00Z`,home:"Gamma",homeId:"3",away:"Delta",awayId:"4",hg:0,ag:0}),
    match({id:`${season}-${competitionCode}-3`,competitionCode,season,playedAt:`${datePrefix}-08T18:00:00Z`,home:"Beta",homeId:"2",away:"Gamma",awayId:"3",hg:3,ag:1})
  ]);
}
function pick(db,code,season,before,fixture){
  return pickCompetitionBaseline(buildCompetitionBaseline(db,code,season,before),fixture,alignContextTeamIds);
}

test("competition-wide baseline is built from all teams, not the two fixture teams",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db);
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,utcDate:"2025-09-10T16:00:00Z"};
  const baseline=pick(db,"PL","2025","2025-09-10T00:00:00Z",fixture);
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
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.equal(raw.sampleCurrentSeason,1);
  assert.equal(raw.samplePreviousSeason,3);
  assert.equal(raw.current,null,"two teams is no wider than the two-team fallback, so current season must not count as a genuine tier");
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,utcDate:"2025-09-10T16:00:00Z"};
  const baseline=pickCompetitionBaseline(raw,fixture,alignContextTeamIds);
  assert.equal(baseline.baselineSource,"PREVIOUS_SEASON");
  const total=baseline.standings.standings.find(s=>s.type==="TOTAL").table;
  assert.equal(total.length,4);
  db.close();
});

test("competition isolation: one competition's baseline never includes another competition's teams",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{competitionCode:"PL"});
  seedFourTeamSeason(db,{competitionCode:"SA",datePrefix:"2025-09"});
  importHistoryMatches(db,[match({id:"sa-extra",competitionCode:"SA",season:"2025",playedAt:"2025-09-09T18:00:00Z",home:"Zulu",homeId:"9",away:"Omega",awayId:"8"})]);
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,utcDate:"2025-09-10T16:00:00Z"};
  const pl=pick(db,"PL","2025","2025-09-10T00:00:00Z",fixture);
  const names=pl.standings.standings.find(s=>s.type==="TOTAL").table.map(row=>row.team.name);
  assert.ok(!names.includes("Zulu")&&!names.includes("Omega"),"SA-only teams must not leak into PL's baseline");
  db.close();
});

test("temporal safety: matches at or after the fixture kickoff are never included",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db);
  importHistoryMatches(db,[match({id:"future",competitionCode:"PL",season:"2025",playedAt:"2025-09-20T18:00:00Z",home:"Alpha",homeId:"1",away:"Delta",awayId:"4",hg:9,ag:0})]);
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,utcDate:"2025-09-10T16:00:00Z"};
  const baseline=pick(db,"PL","2025","2025-09-10T00:00:00Z",fixture);
  const alpha=baseline.standings.standings.find(s=>s.type==="TOTAL").table.find(row=>row.team.name==="Alpha");
  assert.equal(alpha.playedGames,1,"the 2025-09-20 match is after the fixture's own kickoff and must not count");
  db.close();
});

test("a promoted team absent from last season's competition table does not break the baseline or masquerade as history",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // Alpha/Beta/Gamma/Delta played PL last season
  // "Epsilon" is newly promoted this season and has zero PL history of any season.
  importHistoryMatches(db,[match({id:"promoted",competitionCode:"PL",season:"2025",playedAt:"2025-08-20T18:00:00Z",home:"Alpha",homeId:"1",away:"Epsilon",awayId:"5"})]);
  const fixture={home:"Alpha",away:"Epsilon",homeId:101,awayId:105,utcDate:"2025-09-10T16:00:00Z"};
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.equal(raw.current,null,"one team having a single game is no wider than the two-team fallback");
  assert.ok(raw.previous,"the previous season is a genuine, wide baseline in its own right");
  const names=raw.previous.standings.standings.find(s=>s.type==="TOTAL").table.map(row=>row.team.name);
  assert.ok(!names.includes("Epsilon"),"a team with no previous-season row must not be fabricated into the previous-season baseline");
  assert.ok(names.includes("Alpha")&&names.includes("Beta"),"the teams that genuinely have previous-season history must still be present");
  // Epsilon has no row anywhere in the genuine baseline, so picking for THIS
  // fixture correctly finds no covering tier at all — it must not silently
  // fall back to the fixture's own two-team local history being presented
  // as if it were the previous-season competition baseline.
  assert.equal(pickCompetitionBaseline(raw,fixture,alignContextTeamIds),null);
  db.close();
});

test("baselineCoversFixture rejects a foreign provider's numeric team id that coincidentally collides with the fixture's own id",()=>{
  const db=openHistoryDatabase(tempDb());
  // Neither "Hull City" nor "Aston Villa" is in this baseline — the two teams
  // that ARE in it happen to carry the source provider's own numeric ids "64"
  // and "66", which coincidentally equal this fixture's API-Football
  // homeId/awayId as plain numbers.
  seedFourTeamSeason(db,{competitionCode:"PL"});
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  const fixture={id:"hull-villa",home:"Hull City",away:"Aston Villa",homeId:1,awayId:2,utcDate:"2025-09-10T16:00:00Z"};
  // Force the collision deliberately: relabel one genuine row's id to the
  // exact (numeric) homeId of a team that is NOT actually in this table.
  const collided=JSON.parse(JSON.stringify(raw.current.standings));
  collided.standings.find(s=>s.type==="TOTAL").table[0].team.id=fixture.homeId; // still a plain number after JSON round-trip, unmatched by name
  assert.equal(baselineCoversFixture(collided,fixture),false,
    "a same-typed but unmatched id must not be accepted as coverage — only alignContextTeamIds's own reassignment should produce a true match");

  const aligned=alignContextTeamIds({standings:raw.current.standings,finished:[],scheduled:[]},fixture);
  assert.equal(baselineCoversFixture(aligned.standings,fixture),false,
    "alignContextTeamIds correctly leaves unmatched rows alone — coverage must be false when the fixture's real teams are absent from the baseline");
  assert.equal(pickCompetitionBaseline(raw,fixture,alignContextTeamIds),null);
  db.close();
});

test("baselineCoversFixture is true once alignContextTeamIds has genuinely matched both fixture teams by name",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db); // Alpha/Beta/Gamma/Delta
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  const fixture={id:"alpha-beta",home:"Alpha",away:"Beta",homeId:101,awayId:102,utcDate:"2025-09-10T16:00:00Z"};
  const aligned=alignContextTeamIds({standings:raw.current.standings,finished:[],scheduled:[]},fixture);
  assert.equal(baselineCoversFixture(aligned.standings,fixture),true);
  db.close();
});

test("a promoted/relegated team's own history in its OLD division is never borrowed as the NEW competition's baseline",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{competitionCode:"PL",season:"2024",datePrefix:"2024-09"}); // Alpha/Beta/Gamma/Delta in PL last-last season
  // "Epsilon" was relegated FROM the Premier League and has a full season of
  // real PL history — but this fixture is in the CHAMPIONSHIP this season.
  importHistoryMatches(db,[
    {recordKey:"FOOTBALL_DATA:pl-epsilon",sourceFixtureId:"pl-epsilon",playedAt:"2024-09-01T18:00:00Z",status:"FINISHED",sport:"FOOTBALL",
      competition:{code:"PL",name:"PL",season:"2024"},homeTeam:{id:"5",name:"Epsilon"},awayTeam:{id:"1",name:"Alpha"},
      score:{fullTime:{home:2,away:2}},provenance:{source:"FOOTBALL_DATA"},fetchedAt:"2024-09-01T18:00:00Z"}
  ]);
  seedFourTeamSeason(db,{competitionCode:"ELC",season:"2024",datePrefix:"2024-10"}); // genuine Championship history, no Epsilon (distinct dates so its identityKey never collides with the PL seed above)
  const fixture={home:"Epsilon",away:"Alpha",homeId:205,awayId:201,utcDate:"2025-09-10T16:00:00Z"};
  const raw=buildCompetitionBaseline(db,"ELC","2025","2025-09-10T00:00:00Z");
  assert.ok(raw.previous,"a genuine Championship previous-season tier exists");
  const names=raw.previous.standings.standings.find(s=>s.type==="TOTAL").table.map(row=>row.team.name);
  assert.ok(!names.includes("Epsilon"),"Epsilon's Premier League history must never be presented as Championship baseline data");
  assert.equal(raw.previous.baselineTeams,4,"only the genuine Championship teams (Alpha/Beta/Gamma/Delta) count toward this baseline, not Epsilon's PL record");
  // Epsilon itself is absent from the genuine Championship tier, so this
  // specific fixture correctly finds no covering baseline at all.
  assert.equal(pickCompetitionBaseline(raw,fixture,alignContextTeamIds),null);
  db.close();
});

test("current season is preferred over previous season only when it actually covers this fixture's two teams",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // full previous-season table: Alpha/Beta/Gamma/Delta
  // current season has three DIFFERENT teams so far (still clears the
  // genuine-baseline bar) but none of them is "Zeta" — the away side here.
  importHistoryMatches(db,[
    match({id:"cur-1",competitionCode:"PL",season:"2025",playedAt:"2025-09-01T18:00:00Z",home:"Alpha",homeId:"1",away:"Beta",awayId:"2"}),
    match({id:"cur-2",competitionCode:"PL",season:"2025",playedAt:"2025-09-02T18:00:00Z",home:"Gamma",homeId:"3",away:"Delta",awayId:"4"})
  ]);
  const fixture={home:"Alpha",away:"Zeta",homeId:101,awayId:106,utcDate:"2025-09-10T16:00:00Z"};
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.ok(raw.current,"current season already has >=3 teams");
  const baseline=pickCompetitionBaseline(raw,fixture,alignContextTeamIds);
  assert.equal(baseline,null,"Zeta is in neither tier, so no baseline should be picked rather than silently accepting a table missing one of the two teams");
});

test("insufficient data on both tiers is reported explicitly, never silently as a league average",()=>{
  const db=openHistoryDatabase(tempDb());
  importHistoryMatches(db,[match({id:"only-pair",competitionCode:"ELC",season:"2025",playedAt:"2025-09-01T18:00:00Z",home:"Alpha",homeId:"1",away:"Beta",awayId:"2"})]);
  const raw=buildCompetitionBaseline(db,"ELC","2025","2025-09-10T00:00:00Z");
  assert.equal(raw.current,null);
  assert.equal(raw.previous,null);
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,utcDate:"2025-09-10T16:00:00Z"};
  assert.equal(pickCompetitionBaseline(raw,fixture,alignContextTeamIds),null);
  db.close();
});

// ============================================================================
// resolveTeamStrengthBaseline — 09.09 forensic audit follow-up. A live
// current-season standings table (rawContext.standings) is no longer treated
// as authoritative merely for existing: it must be MATURE for THIS fixture's
// two teams (>=4 games each — the same per-team bar localHistory.js already
// requires of its own two-team fallback), or a genuine SQLite competition
// baseline (current season, then previous season) is preferred instead.
// ============================================================================

function liveWith(teamRows){
  return {standings:{standings:[{type:"TOTAL",table:teamRows}]},finished:[],scheduled:[]};
}

test("A) thin current-season live standings (1 game each) defers to an available previous-season baseline",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // Alpha/Beta/Gamma/Delta, previous season
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext=liveWith([
    {team:{id:"1",name:"Alpha"},playedGames:1,goalsFor:1,goalsAgainst:0},
    {team:{id:"2",name:"Beta"},playedGames:1,goalsFor:0,goalsAgainst:1}
  ]);
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false);
  assert.ok(result.competitionBaseline,"a previous-season baseline must be picked");
  assert.equal(result.competitionBaseline.baselineSource,"PREVIOUS_SEASON");
  assert.equal(result.baseContext.standings,result.competitionBaseline.standings);
  db.close();
});

test("B) 2-3 game current-season live standings still counts as thin and defers the same way as 1 game",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"});
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  for(const playedGames of [2,3]){
    const rawContext=liveWith([
      {team:{id:"1",name:"Alpha"},playedGames,goalsFor:playedGames,goalsAgainst:playedGames-1},
      {team:{id:"2",name:"Beta"},playedGames,goalsFor:playedGames-1,goalsAgainst:playedGames}
    ]);
    const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
    assert.equal(result.liveStandingsMature,false,`playedGames=${playedGames} must still be considered thin`);
    assert.equal(result.competitionBaseline.baselineSource,"PREVIOUS_SEASON");
  }
  db.close();
});

test("C) a mature current-season live table (>=4 games each) keeps LIVE_API as priority over a previous-season baseline",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // must NOT be used — current is mature
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext=liveWith([
    {team:{id:"1",name:"Alpha"},playedGames:5,goalsFor:8,goalsAgainst:4},
    {team:{id:"2",name:"Beta"},playedGames:5,goalsFor:6,goalsAgainst:5}
  ]);
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,true);
  assert.equal(result.competitionBaseline,null,"the SQLite baseline must not even be consulted when the live table is already mature");
  assert.deepEqual(result.baseContext.standings,alignContextTeamIds(rawContext,fixture).standings);
  db.close();
});

test("D) thin current standings with no previous-season baseline defers to sufficient local history",()=>{
  const db=openHistoryDatabase(tempDb());
  // No previous-season rows seeded — genuinely absent, unlike scenario A/B.
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext=liveWith([
    {team:{id:"1",name:"Alpha"},playedGames:1,goalsFor:1,goalsAgainst:0},
    {team:{id:"2",name:"Beta"},playedGames:1,goalsFor:0,goalsAgainst:1}
  ]);
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.competitionBaseline,null,"no previous-season baseline exists for this competition");
  assert.equal(result.baseContext.standings,null,"the thin live table must be cleared, not kept merely for being non-null");

  const localHistoryRows=[];
  for(let i=1;i<=4;i++){
    localHistoryRows.push({recordKey:`SIM:h${i}`,sourceFixtureId:`h${i}`,playedAt:`2025-08-0${i}T18:00:00Z`,homeTeam:{id:101,name:"Alpha"},awayTeam:{id:9000+i,name:`Opp${i}`},score:{fullTime:{home:1,away:0}},status:"FT",provenance:{source:"SIM"}});
    localHistoryRows.push({recordKey:`SIM:a${i}`,sourceFixtureId:`a${i}`,playedAt:`2025-08-1${i}T18:00:00Z`,homeTeam:{id:9100+i,name:`Opp${i}b`},awayTeam:{id:102,name:"Beta"},score:{fullTime:{home:0,away:1}},status:"FT",provenance:{source:"SIM"}});
  }
  const merged=mergeWithLocalHistory(result.baseContext,localHistoryRows,fixture);
  assert.ok(merged.standings,"local history must supply standings once the thin live table is cleared");
  assert.equal(merged.localHistoryMeta.homeMatches,4);
  assert.equal(merged.localHistoryMeta.awayMatches,4);
  db.close();
});

test("E) no mature source anywhere: teamStrengthModel does not fabricate a confident forecast",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext=liveWith([
    {team:{id:"1",name:"Alpha"},playedGames:1,goalsFor:1,goalsAgainst:0},
    {team:{id:"2",name:"Beta"},playedGames:1,goalsFor:0,goalsAgainst:1}
  ]);
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.baseContext.standings,null);
  const merged=mergeWithLocalHistory(result.baseContext,[],fixture); // no local history at all either
  assert.equal(merged.standings,null);
  assert.equal(teamStrengthModel(fixture,merged),null,"with no usable source at all the model must return null (WAIT), not a fabricated forecast");
  db.close();
});

// 09.09 forensic audit — the exact reported anomalies, now proven prevented
// at the data-selection stage (not just caught after the fact by the
// EXTREME_EXPECTED_GOALS sanity guard, which stays as a last-resort backstop
// per analyse.js).
test("67% DRAW regression: a thin current-season table no longer feeds teamStrengthModel when a real previous-season baseline exists",()=>{
  const db=openHistoryDatabase(tempDb());
  importHistoryMatches(db,[
    match({id:"p1",competitionCode:"CL",season:"2024",playedAt:"2024-09-01T18:00:00Z",home:"Barcelona",homeId:"81",away:"OppA",awayId:"901",hg:2,ag:1}),
    match({id:"p2",competitionCode:"CL",season:"2024",playedAt:"2024-09-08T18:00:00Z",home:"OppB",homeId:"902",away:"Barcelona",awayId:"81",hg:1,ag:2}),
    match({id:"p3",competitionCode:"CL",season:"2024",playedAt:"2024-09-15T18:00:00Z",home:"Barcelona",homeId:"81",away:"OppC",awayId:"903",hg:2,ag:0}),
    match({id:"p4",competitionCode:"CL",season:"2024",playedAt:"2024-09-05T18:00:00Z",home:"Feyenoord",homeId:"675",away:"OppA",awayId:"901",hg:1,ag:1}),
    match({id:"p5",competitionCode:"CL",season:"2024",playedAt:"2024-09-12T18:00:00Z",home:"OppB",homeId:"902",away:"Feyenoord",awayId:"675",hg:1,ag:2}),
    match({id:"p6",competitionCode:"CL",season:"2024",playedAt:"2024-09-19T18:00:00Z",home:"Feyenoord",homeId:"675",away:"OppC",awayId:"903",hg:2,ag:1})
  ]);
  const fixture={home:"Barcelona",away:"Feyenoord",homeId:81,awayId:675,competitionCode:"CL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  // Thin CURRENT live table — the exact shape (low goals over few games) that
  // previously reproduced λ=(0.25,0.20) -> P(draw)=66.99% when used directly.
  const rawContext=liveWith([
    {team:{id:"81",name:"Barcelona"},playedGames:3,goalsFor:1,goalsAgainst:1},
    {team:{id:"675",name:"Feyenoord"},playedGames:3,goalsFor:1,goalsAgainst:1}
  ]);
  const naiveStrength=teamStrengthModel(fixture,alignContextTeamIds(rawContext,fixture));
  assert.ok(naiveStrength.lambdas.home<0.5&&naiveStrength.lambdas.away<0.5,"the thin table, used naively, is still a near-degenerate low-λ read");

  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false);
  assert.equal(result.competitionBaseline.baselineSource,"PREVIOUS_SEASON");
  const merged=mergeWithLocalHistory(result.baseContext,[],fixture);
  const fixedStrength=teamStrengthModel(fixture,merged);
  assert.notDeepEqual(fixedStrength.lambdas,{home:0.25,away:0.2},"must not reproduce the exact reported degenerate λ pair");
  assert.notDeepEqual(fixedStrength.lambdas,naiveStrength.lambdas,"the previous-season baseline must actually change what feeds the model, not just be picked and ignored");
  db.close();
});

test("CEILING regression: a thin current-season table no longer feeds teamStrengthModel when a real previous-season baseline exists",()=>{
  const db=openHistoryDatabase(tempDb());
  importHistoryMatches(db,[
    match({id:"p1",competitionCode:"MLS",season:"2024",playedAt:"2024-09-01T18:00:00Z",home:"Minnesota United",homeId:"9001",away:"OppA",awayId:"9101",hg:2,ag:1}),
    match({id:"p2",competitionCode:"MLS",season:"2024",playedAt:"2024-09-08T18:00:00Z",home:"OppB",homeId:"9102",away:"Minnesota United",awayId:"9001",hg:1,ag:1}),
    match({id:"p2b",competitionCode:"MLS",season:"2024",playedAt:"2024-09-15T18:00:00Z",home:"Minnesota United",homeId:"9001",away:"OppC",awayId:"9103",hg:1,ag:0}),
    match({id:"p3",competitionCode:"MLS",season:"2024",playedAt:"2024-09-05T18:00:00Z",home:"FC Dallas",homeId:"9002",away:"OppA",awayId:"9101",hg:1,ag:2}),
    match({id:"p4",competitionCode:"MLS",season:"2024",playedAt:"2024-09-12T18:00:00Z",home:"OppB",homeId:"9102",away:"FC Dallas",awayId:"9002",hg:0,ag:1}),
    match({id:"p4b",competitionCode:"MLS",season:"2024",playedAt:"2024-09-19T18:00:00Z",home:"FC Dallas",homeId:"9002",away:"OppC",awayId:"9103",hg:2,ag:1})
  ]);
  const fixture={home:"Minnesota United",away:"FC Dallas",homeId:9001,awayId:9002,competitionCode:"MLS",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  // Thin CURRENT live table, both sides high-scoring — the mirror-image shape
  // that previously reproduced λ=(3.4,3.1) -> Fair(Over 5)≈1.36 when used
  // directly (both λ pinned at the model's own ceiling clamp).
  const rawContext=liveWith([
    {team:{id:"9001",name:"Minnesota United"},playedGames:3,goalsFor:30,goalsAgainst:30},
    {team:{id:"9002",name:"FC Dallas"},playedGames:3,goalsFor:30,goalsAgainst:30}
  ]);
  const naiveStrength=teamStrengthModel(fixture,alignContextTeamIds(rawContext,fixture));
  assert.deepEqual(naiveStrength.lambdas,{home:3.4,away:3.1},"the thin table, used naively, must reproduce the exact reported ceiling collapse");

  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false);
  assert.equal(result.competitionBaseline.baselineSource,"PREVIOUS_SEASON");
  const merged=mergeWithLocalHistory(result.baseContext,[],fixture);
  const fixedStrength=teamStrengthModel(fixture,merged);
  assert.notDeepEqual(fixedStrength.lambdas,{home:3.4,away:3.1},"must not reproduce the exact reported ceiling λ pair");
  db.close();
});
