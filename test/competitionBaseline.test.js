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

// Each of Alpha/Beta/Gamma/Delta gets exactly 4 HOME games AND 4 AWAY games
// (16 matches total, 8 games per team) — not just 4 games total. venue-
// specific maturity (hasMatureVenueSplits) checks the HOME table row for
// whichever team is home in a given fixture and the AWAY table row for
// whichever is away, so a team needs >=4 at THAT specific venue, not merely
// >=4 games combined across both venues.
const FOUR_TEAM_SCHEDULE=[
  ["Alpha","Beta","01","00"],["Alpha","Gamma","01","12"],["Alpha","Delta","02","00"],["Alpha","Beta","02","12"],
  ["Beta","Gamma","03","00"],["Beta","Delta","03","12"],["Beta","Alpha","04","00"],["Beta","Gamma","04","12"],
  ["Gamma","Delta","05","00"],["Gamma","Alpha","05","12"],["Gamma","Beta","06","00"],["Gamma","Delta","06","12"],
  ["Delta","Alpha","07","00"],["Delta","Beta","07","12"],["Delta","Gamma","08","00"],["Delta","Alpha","08","12"]
];
const TEAM_IDS={Alpha:"1",Beta:"2",Gamma:"3",Delta:"4"};
function seedFourTeamSeason(db,{competitionCode="PL",season="2025",datePrefix="2025-09"}={}){
  importHistoryMatches(db,FOUR_TEAM_SCHEDULE.map(([home,away,day,hour],i)=>
    match({id:`${season}-${competitionCode}-${i+1}`,competitionCode,season,playedAt:`${datePrefix}-${day}T${hour}:00:00Z`,home,homeId:TEAM_IDS[home],away,awayId:TEAM_IDS[away],hg:1+(i%3),ag:i%2})
  ));
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
  assert.equal(baseline.baselineSample,16);
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
  assert.equal(raw.samplePreviousSeason,16);
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
  assert.equal(alpha.playedGames,8,"the 2025-09-20 match is after the fixture's own kickoff and must not count (only the 8 pre-kickoff seed games do)");
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

// A live table with a genuine HOME row for the home team and a genuine AWAY
// row for the away team (>=4 games each), not merely a TOTAL table — the
// shape a live provider with real venue-specific standings actually has.
function liveWithVenueSplits({homeId,homeName,homePlayedGames,awayId,awayName,awayPlayedGames}){
  return {standings:{standings:[
    {type:"TOTAL",table:[
      {team:{id:homeId,name:homeName},playedGames:homePlayedGames,goalsFor:homePlayedGames+3,goalsAgainst:homePlayedGames},
      {team:{id:awayId,name:awayName},playedGames:awayPlayedGames,goalsFor:awayPlayedGames,goalsAgainst:awayPlayedGames+3}
    ]},
    {type:"HOME",table:[{team:{id:homeId,name:homeName},playedGames:homePlayedGames,goalsFor:homePlayedGames+3,goalsAgainst:homePlayedGames}]},
    {type:"AWAY",table:[{team:{id:awayId,name:awayName},playedGames:awayPlayedGames,goalsFor:awayPlayedGames,goalsAgainst:awayPlayedGames+3}]}
  ]},finished:[],scheduled:[]};
}

test("C) a mature current-season live table WITH genuine HOME/AWAY splits (>=4 games each) keeps LIVE_API as priority over a previous-season baseline",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // must NOT be used — current is mature
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext=liveWithVenueSplits({homeId:"1",homeName:"Alpha",homePlayedGames:5,awayId:"2",awayName:"Beta",awayPlayedGames:5});
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,true);
  assert.equal(result.competitionBaseline,null,"the SQLite baseline must not even be consulted when the live table is already mature with real venue splits");
  assert.deepEqual(result.baseContext.standings,alignContextTeamIds(rawContext,fixture).standings);
  db.close();
});

// The exact confirmed bug shape (Mirassol-Vitória et al.): a live table that
// is deep on TOTAL (>=4 games) but carries NO genuine HOME/AWAY tables at
// all must NOT be treated as mature — it must defer to a real SQLite
// venue-split baseline instead, however many TOTAL games it shows.
test("C2) a deep TOTAL-only live table (no HOME/AWAY types at all) is rejected even though it clears the TOTAL depth bar",()=>{
  const db=openHistoryDatabase(tempDb());
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // genuine venue-split previous season, must win instead
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext=liveWith([
    {team:{id:"1",name:"Alpha"},playedGames:26,goalsFor:29,goalsAgainst:40},
    {team:{id:"2",name:"Beta"},playedGames:26,goalsFor:25,goalsAgainst:37}
  ]);
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false,"TOTAL depth alone (26 games) must not count as mature without real HOME/AWAY tables");
  assert.equal(result.competitionBaseline.baselineSource,"PREVIOUS_SEASON");
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
    match({id:"p3b",competitionCode:"CL",season:"2024",playedAt:"2024-09-22T18:00:00Z",home:"OppD",homeId:"904",away:"Barcelona",awayId:"81",hg:0,ag:1}),
    // Barcelona is HOME in this fixture — needs >=4 games in the HOME table
    // specifically (p1,p3 above give only 2), not just >=4 TOTAL.
    match({id:"p3c",competitionCode:"CL",season:"2024",playedAt:"2024-09-29T18:00:00Z",home:"Barcelona",homeId:"81",away:"OppE",awayId:"905",hg:3,ag:0}),
    match({id:"p3d",competitionCode:"CL",season:"2024",playedAt:"2024-10-06T18:00:00Z",home:"Barcelona",homeId:"81",away:"OppF",awayId:"906",hg:1,ag:0}),
    match({id:"p4",competitionCode:"CL",season:"2024",playedAt:"2024-09-05T18:00:00Z",home:"Feyenoord",homeId:"675",away:"OppA",awayId:"901",hg:1,ag:1}),
    match({id:"p5",competitionCode:"CL",season:"2024",playedAt:"2024-09-12T18:00:00Z",home:"OppB",homeId:"902",away:"Feyenoord",awayId:"675",hg:1,ag:2}),
    match({id:"p6",competitionCode:"CL",season:"2024",playedAt:"2024-09-19T18:00:00Z",home:"Feyenoord",homeId:"675",away:"OppC",awayId:"903",hg:2,ag:1}),
    match({id:"p6b",competitionCode:"CL",season:"2024",playedAt:"2024-09-26T18:00:00Z",home:"OppD",homeId:"904",away:"Feyenoord",awayId:"675",hg:0,ag:2}),
    // Feyenoord is AWAY in this fixture — needs >=4 games in the AWAY table
    // specifically (p5,p6b above give only 2), not just >=4 TOTAL.
    match({id:"p6c",competitionCode:"CL",season:"2024",playedAt:"2024-09-29T18:00:00Z",home:"OppE",homeId:"905",away:"Feyenoord",awayId:"675",hg:1,ag:0}),
    match({id:"p6d",competitionCode:"CL",season:"2024",playedAt:"2024-10-06T18:00:00Z",home:"OppF",homeId:"906",away:"Feyenoord",awayId:"675",hg:0,ag:1})
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
    match({id:"p2c",competitionCode:"MLS",season:"2024",playedAt:"2024-09-22T18:00:00Z",home:"OppD",homeId:"9104",away:"Minnesota United",awayId:"9001",hg:0,ag:2}),
    // Minnesota is HOME in this fixture — needs >=4 games in the HOME table
    // specifically (p1,p2b above give only 2), not just >=4 TOTAL.
    match({id:"p2d",competitionCode:"MLS",season:"2024",playedAt:"2024-09-29T18:00:00Z",home:"Minnesota United",homeId:"9001",away:"OppE",awayId:"9105",hg:2,ag:0}),
    match({id:"p2e",competitionCode:"MLS",season:"2024",playedAt:"2024-10-06T18:00:00Z",home:"Minnesota United",homeId:"9001",away:"OppF",awayId:"9106",hg:1,ag:0}),
    match({id:"p3",competitionCode:"MLS",season:"2024",playedAt:"2024-09-05T18:00:00Z",home:"FC Dallas",homeId:"9002",away:"OppA",awayId:"9101",hg:1,ag:2}),
    match({id:"p4",competitionCode:"MLS",season:"2024",playedAt:"2024-09-12T18:00:00Z",home:"OppB",homeId:"9102",away:"FC Dallas",awayId:"9002",hg:0,ag:1}),
    match({id:"p4b",competitionCode:"MLS",season:"2024",playedAt:"2024-09-19T18:00:00Z",home:"FC Dallas",homeId:"9002",away:"OppC",awayId:"9103",hg:2,ag:1}),
    match({id:"p4c",competitionCode:"MLS",season:"2024",playedAt:"2024-09-26T18:00:00Z",home:"OppD",homeId:"9104",away:"FC Dallas",awayId:"9002",hg:0,ag:1}),
    // FC Dallas is AWAY in this fixture — needs >=4 games in the AWAY table
    // specifically (p4,p4c above give only 2), not just >=4 TOTAL.
    match({id:"p4d",competitionCode:"MLS",season:"2024",playedAt:"2024-09-29T18:00:00Z",home:"OppE",homeId:"9105",away:"FC Dallas",awayId:"9002",hg:1,ag:0}),
    match({id:"p4e",competitionCode:"MLS",season:"2024",playedAt:"2024-10-06T18:00:00Z",home:"OppF",homeId:"9106",away:"FC Dallas",awayId:"9002",hg:0,ag:1})
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

// ============================================================================
// Baseline DEPTH follow-up — a picked tier can clear MIN_TEAMS_FOR_GENUINE_
// BASELINE (wide: many distinct teams) while every one of those teams,
// including this fixture's own two, has played only 1-3 games (shallow).
// pickCompetitionBaseline must now also require MIN_GAMES_FOR_MATURE_
// STANDINGS for the fixture's specific two teams in whichever tier it is
// about to accept — reusing the exact bar already used for the live table,
// not a new number.
// ============================================================================

// Builds a "wide but shallow" tier: `width` teams total, each appearing in
// exactly one game (an opening-matchday shape), via `width/2` distinct pairs.
function seedOpeningMatchday(db,{competitionCode="PL",season="2025",datePrefix="2025-09",width=6,homeName="Alpha",homeId="1",homePlayedGames=1,awayName="Beta",awayId="2",awayPlayedGames=1}={}){
  const rows=[];
  // The fixture's own two teams get exactly the requested playedGames each,
  // via that many distinct 1-off opponents (never each other, so their
  // numbers stay independent and easy to reason about).
  for(let i=0;i<homePlayedGames;i++)
    rows.push(match({id:`${season}-${competitionCode}-home${i}`,competitionCode,season,playedAt:`${datePrefix}-0${i+1}T18:00:00Z`,home:homeName,homeId,away:`HomeOpp${i}`,awayId:`h-opp-${i}`,hg:1,ag:0}));
  for(let i=0;i<awayPlayedGames;i++)
    rows.push(match({id:`${season}-${competitionCode}-away${i}`,competitionCode,season,playedAt:`${datePrefix}-07T${String(i).padStart(2,"0")}:00:00Z`,home:`AwayOpp${i}`,homeId:`a-opp-${i}`,away:awayName,awayId,hg:1,ag:1}));
  // Pad the remaining width with independent one-off pairs so the tier
  // clears MIN_TEAMS_FOR_GENUINE_BASELINE purely on team count. home/away
  // already contributed 2 + homePlayedGames + awayPlayedGames distinct teams
  // (the two named teams plus one opponent per game each).
  const nonPadTeams=2+homePlayedGames+awayPlayedGames;
  const padPairs=Math.max(0,Math.ceil((width-nonPadTeams)/2));
  for(let i=0;i<padPairs;i++)
    rows.push(match({id:`${season}-${competitionCode}-pad${i}`,competitionCode,season,playedAt:`${datePrefix}-06T${String(i%24).padStart(2,"0")}:00:00Z`,home:`Pad${i}A`,homeId:`pad-${i}-a`,away:`Pad${i}B`,awayId:`pad-${i}-b`,hg:2,ag:1}));
  importHistoryMatches(db,rows);
}

test("DEPTH A) a wide (26-team) current baseline with 1 game each for the fixture's two teams is rejected in favour of a mature previous-season baseline",()=>{
  const db=openHistoryDatabase(tempDb());
  seedOpeningMatchday(db,{season:"2025",datePrefix:"2025-09",width:26,homePlayedGames:1,awayPlayedGames:1});
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"}); // Alpha/Beta each get 4 games — mature previous tier
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.ok(raw.current,"the current tier clears the team-count bar (26 teams)");
  const baseline=pickCompetitionBaseline(raw,fixture,alignContextTeamIds);
  assert.equal(baseline.baselineSource,"PREVIOUS_SEASON","the wide-but-shallow current tier must be rejected, not just the live table");
  db.close();
});

test("DEPTH B) asymmetric depth (home=3, away=5) is still rejected — BOTH teams must individually clear the bar",()=>{
  const db=openHistoryDatabase(tempDb());
  seedOpeningMatchday(db,{season:"2025",datePrefix:"2025-09",width:10,homePlayedGames:3,awayPlayedGames:5});
  seedFourTeamSeason(db,{season:"2024",datePrefix:"2024-09"});
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  const baseline=pickCompetitionBaseline(raw,fixture,alignContextTeamIds);
  assert.equal(baseline.baselineSource,"PREVIOUS_SEASON","home=3 alone is enough to reject the current tier, regardless of away=5");
  db.close();
});

test("DEPTH C) both teams at exactly 4 games each is accepted as CURRENT_SEASON",()=>{
  const db=openHistoryDatabase(tempDb());
  seedOpeningMatchday(db,{season:"2025",datePrefix:"2025-09",width:10,homePlayedGames:4,awayPlayedGames:4});
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-30T16:00:00Z"};
  const raw=buildCompetitionBaseline(db,"PL","2025","2025-09-30T00:00:00Z");
  const baseline=pickCompetitionBaseline(raw,fixture,alignContextTeamIds);
  assert.equal(baseline.baselineSource,"CURRENT_SEASON");
  const total=baseline.standings.standings.find(s=>s.type==="TOTAL").table;
  assert.equal(total.find(r=>r.team.id===101).playedGames,4);
  assert.equal(total.find(r=>r.team.id===102).playedGames,4);
  db.close();
});

test("DEPTH D) current and previous both shallow for this fixture: local history is used instead",()=>{
  const db=openHistoryDatabase(tempDb());
  seedOpeningMatchday(db,{season:"2025",datePrefix:"2025-09",width:26,homePlayedGames:1,awayPlayedGames:1});
  seedOpeningMatchday(db,{season:"2024",datePrefix:"2024-09",width:10,homePlayedGames:2,awayPlayedGames:2}); // previous exists but is ALSO shallow for Alpha/Beta
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext={standings:null,finished:[],scheduled:[]};
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.competitionBaseline,null,"neither tier is deep enough for Alpha/Beta specifically");
  assert.equal(result.baseContext.standings,null);

  const localHistoryRows=[];
  for(let i=1;i<=4;i++){
    localHistoryRows.push({recordKey:`SIM:h${i}`,sourceFixtureId:`h${i}`,playedAt:`2025-08-0${i}T18:00:00Z`,homeTeam:{id:101,name:"Alpha"},awayTeam:{id:9000+i,name:`LOpp${i}`},score:{fullTime:{home:1,away:0}},status:"FT",provenance:{source:"SIM"}});
    localHistoryRows.push({recordKey:`SIM:a${i}`,sourceFixtureId:`a${i}`,playedAt:`2025-08-1${i}T18:00:00Z`,homeTeam:{id:9100+i,name:`LOpp${i}b`},awayTeam:{id:102,name:"Beta"},score:{fullTime:{home:0,away:1}},status:"FT",provenance:{source:"SIM"}});
  }
  const merged=mergeWithLocalHistory(result.baseContext,localHistoryRows,fixture);
  assert.ok(merged.standings,"local history must supply standings once both SQLite tiers are rejected for depth");
  assert.equal(merged.localHistoryMeta.homeMatches,4);
  assert.equal(merged.localHistoryMeta.awayMatches,4);
  const strength=teamStrengthModel(fixture,merged);
  assert.ok(strength,"local history is mature enough to produce a real Team Strength estimate");
  db.close();
});

test("DEPTH E) current shallow, previous unavailable, local history insufficient: Team Strength is null (WAIT), not fabricated",()=>{
  const db=openHistoryDatabase(tempDb());
  seedOpeningMatchday(db,{season:"2025",datePrefix:"2025-09",width:26,homePlayedGames:1,awayPlayedGames:1});
  // No previous-season rows seeded at all — genuinely absent.
  const fixture={home:"Alpha",away:"Beta",homeId:101,awayId:102,competitionCode:"PL",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext={standings:null,finished:[],scheduled:[]};
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.competitionBaseline,null);
  assert.equal(result.baseContext.standings,null);
  const merged=mergeWithLocalHistory(result.baseContext,[],fixture); // no local history either
  assert.equal(merged.standings,null);
  assert.equal(teamStrengthModel(fixture,merged),null,"no usable source anywhere must yield WAIT, not a fabricated forecast");
  db.close();
});

test("DEPTH F) MLS-shaped regression: a 26-team/13-match opening-matchday baseline (1 game per team) must not be accepted",()=>{
  const db=openHistoryDatabase(tempDb());
  seedOpeningMatchday(db,{competitionCode:"MLS",season:"2026",datePrefix:"2026-09",width:26,homeName:"CF Montreal",homeId:"1614",homePlayedGames:1,awayName:"Charlotte",awayId:"18310",awayPlayedGames:1});
  const fixture={home:"CF Montreal",away:"Charlotte",homeId:1614,awayId:18310,competitionCode:"MLS",seasonStart:"2026",utcDate:"2026-09-09T23:30:00+00:00"};
  const raw=buildCompetitionBaseline(db,"MLS","2026","2026-09-09T23:30:00+00:00");
  assert.equal(raw.current.baselineSample,13,"reproduces the exact reported shape: 13 matches");
  assert.equal(raw.current.baselineTeams,26,"reproduces the exact reported shape: 26 teams");
  const baseline=pickCompetitionBaseline(raw,fixture,alignContextTeamIds);
  assert.equal(baseline,null,"wide-but-1-game-per-team must NOT be accepted merely for clearing the team-count bar");
  db.close();
});

// 5 flagged + 3 previously-unflagged production fixtures from the 09.09
// refresh (HEAD be52619) — every one of them drew its λ from this exact
// same wide/shallow (26 teams, 1 game each) MLS opening-matchday tier. None
// of the 8 should still reach teamStrengthModel through that tier.
test("DEPTH G) all 8 real 09.09 MLS fixtures (5 flagged + 3 previously-unflagged) reject the n=1 opening-matchday baseline",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixtures=[
    {home:"CF Montreal",away:"Charlotte",homeId:1614,awayId:18310},
    {home:"Chicago Fire",away:"Inter Miami",homeId:1607,awayId:9568},
    {home:"Minnesota United FC",away:"FC Dallas",homeId:1612,awayId:1597},
    {home:"Houston Dynamo",away:"Real Salt Lake",homeId:1600,awayId:1606},
    {home:"Los Angeles FC",away:"New York Red Bulls",homeId:1616,awayId:1602},
    {home:"Atlanta United FC",away:"Orlando City SC",homeId:1608,awayId:1598},
    {home:"Austin",away:"Colorado Rapids",homeId:16489,awayId:1610},
    {home:"Portland Timbers",away:"St. Louis City",homeId:1617,awayId:20787}
  ].map(f=>({...f,competitionCode:"MLS",seasonStart:"2026",utcDate:"2026-09-09T23:30:00+00:00"}));

  // One real opening matchday: each of the 16 named teams plus enough filler
  // pairs to reach the real 26-team/13-match shape, every team exactly 1 game.
  const rows=fixtures.map((f,i)=>match({id:`md1-${i}`,competitionCode:"MLS",season:"2026",playedAt:`2026-09-0${(i%9)+1}T18:00:00Z`,home:f.home,homeId:String(f.homeId),away:f.away,awayId:String(f.awayId),hg:i%3,ag:(i+1)%3}));
  rows.push(match({id:"md1-pad",competitionCode:"MLS",season:"2026",playedAt:"2026-09-01T12:00:00Z",home:"PadA",homeId:"pad-a",away:"PadB",awayId:"pad-b",hg:1,ag:0}));
  importHistoryMatches(db,rows);

  const raw=buildCompetitionBaseline(db,"MLS","2026","2026-09-09T23:30:00+00:00");
  assert.equal(raw.current.baselineTeams,18,"16 real teams + 2 filler teams");
  for(const fixture of fixtures){
    const result=resolveTeamStrengthBaseline(db,{standings:null,finished:[],scheduled:[]},fixture,alignContextTeamIds,fixture.utcDate);
    assert.equal(result.competitionBaseline,null,`${fixture.home} - ${fixture.away}: the 1-game-per-team tier must not be accepted`);
    assert.equal(result.baseContext.standings,null,`${fixture.home} - ${fixture.away}: no standings should reach teamStrengthModel`);
  }
  db.close();
});

// ============================================================================
// VENUE SPLITS — 14/09 forensic audit. Some live providers (confirmed:
// Football-Data for Brazil Série A, Portugal Primeira Liga, Spain La Liga)
// return ONLY a TOTAL standings table — no HOME/AWAY types at all
// (homeAwayScore=0 in the production diagnostic). teamStrengthModel's own
// `homeH = row(homeTable(context),homeId) || totalH` fallback then silently
// substitutes each team's full TOTAL record for its venue-specific one.
// hasMatureVenueSplits (competitionBaseline.js) now stops that substitution
// at the context-selection stage: a source without genuine, mature HOME/AWAY
// rows for both fixture teams is never treated as usable for Team Strength,
// regardless of how many TOTAL games it shows.
//
// Real λ values below (Mirassol-Vitória) come directly from the forensic
// audit's live reconstruction (Football-Data TOTAL-only: λ 1.2936885893 /
// 1.0270559371; SQLite CURRENT_SEASON with genuine splits: λ 2.3045 / 0.6269
// — driven by Vitória's real 13-game AWAY record, 0W-4D-9L, 8 GF/28 GA,
// far weaker than its 26-game TOTAL record). Rio Ave-Estrela, Moreirense-
// Marítimo and Villarreal-Betis reproduce the SAME confirmed shape
// (source=FOOTBALL_DATA, homeAwayScore=0, baselineSample=0) — their exact
// historical underlying goals data is NOT recoverable (no state-snapshot or
// SQLite history exists for 14/09, disclosed in the forensic report), so
// these three use representative, clearly-synthetic goal data that
// reproduces the SAME class of naive-substitution defect, not a claim of
// their real historical numbers.
// ============================================================================

// A TOTAL-only "live" context shaped exactly like Football-Data's response
// for leagues with no HOME/AWAY split support.
function totalOnly(homeId,homeName,homeGames,homeGF,homeGA,awayId,awayName,awayGames,awayGF,awayGA){
  return {standings:{standings:[{type:"TOTAL",table:[
    {team:{id:homeId,name:homeName},playedGames:homeGames,goalsFor:homeGF,goalsAgainst:homeGA},
    {team:{id:awayId,name:awayName},playedGames:awayGames,goalsFor:awayGF,goalsAgainst:awayGA}
  ]}]},finished:[],scheduled:[]};
}

// Builds a genuine SQLite venue-split source: `homeGames` real HOME
// appearances for the home team and `awayGames` real AWAY appearances for
// the away team, plus enough padding teams to clear MIN_TEAMS_FOR_GENUINE_BASELINE.
function seedVenueSplitLeague(db,{competitionCode,season="2025",datePrefix="2025-09",homeName,homeId,homeGames=4,homeGF=1,homeGA=1,awayName,awayId,awayGames=4,awayGF=1,awayGA=1}){
  const rows=[];
  for(let i=0;i<homeGames;i++)
    rows.push(match({id:`${competitionCode}-${season}-h${i}`,competitionCode,season,playedAt:`${datePrefix}-0${i+1}T18:00:00Z`,home:homeName,homeId,away:`Opp${i}H`,awayId:`opp-h-${i}`,hg:homeGF,ag:homeGA}));
  for(let i=0;i<awayGames;i++)
    rows.push(match({id:`${competitionCode}-${season}-a${i}`,competitionCode,season,playedAt:`${datePrefix}-07T${String(i).padStart(2,"0")}:00:00Z`,home:`Opp${i}A`,homeId:`opp-a-${i}`,away:awayName,awayId,hg:awayGA,ag:awayGF}));
  importHistoryMatches(db,rows);
}

test("Mirassol-Vitória: TOTAL-only FOOTBALL_DATA (λ 1.2937/1.0271 reproduced) does not substitute for HOME/AWAY; mature SQLite venue splits are used instead",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixture={home:"Mirassol FC",away:"EC Vitória",homeId:4364,awayId:1782,competitionCode:"BSA",seasonStart:"2026",utcDate:"2026-09-14T19:00:00Z"};
  // Exact real Football-Data TOTAL row values from the forensic audit.
  const rawContext=totalOnly(4364,"Mirassol FC",26,29,40,1782,"EC Vitória",26,25,37);
  const naive=teamStrengthModel(fixture,alignContextTeamIds(rawContext,fixture));
  assert.ok(naive,"the naive TOTAL-as-venue substitution still produces A number — that's exactly the bug, not a crash");

  seedVenueSplitLeague(db,{competitionCode:"BSA",season:"2026",datePrefix:"2026-09",homeName:"Mirassol FC",homeId:"4364",homeGames:6,homeGF:1,homeGA:1,awayName:"EC Vitória",awayId:"1782",awayGames:6,awayGF:0,awayGA:2});
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false,"a TOTAL-only table must never count as mature, however many games it shows");
  assert.equal(result.competitionBaseline.baselineSource,"CURRENT_SEASON");
  const merged=mergeWithLocalHistory(result.baseContext,[],fixture);
  const fixed=teamStrengthModel(fixture,merged);
  assert.notDeepEqual(fixed.lambdas,naive.lambdas,"the genuine venue-split source must produce a materially different λ than the rejected TOTAL-only substitution");
  db.close();
});

test("Rio Ave-Estrela: TOTAL-only FOOTBALL_DATA must not push λAway to 3.10 via TOTAL-as-AWAY substitution",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixture={home:"Rio Ave FC",away:"CF Estrela da Amadora",homeId:496,awayId:9136,competitionCode:"PPL",seasonStart:"2026",utcDate:"2026-09-14T18:00:00Z"};
  // Representative synthetic shape (real historical data not recoverable —
  // see forensic report) reproducing the SAME naive-ceiling defect class
  // already proven for MLS (both high-scoring, TOTAL-only, 3 games).
  const rawContext=totalOnly(496,"Rio Ave FC",3,30,30,9136,"CF Estrela da Amadora",3,30,30);
  const naive=teamStrengthModel(fixture,alignContextTeamIds(rawContext,fixture));
  assert.equal(naive.lambdas.away,3.1,"reproduces the naive TOTAL-as-AWAY ceiling collapse this fix must prevent from reaching Team Strength");

  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false);
  assert.equal(result.baseContext.standings,null,"no SQLite/local fallback seeded here — the TOTAL-only table must be cleared, not silently kept");
  db.close();
});

test("Moreirense-Marítimo: TOTAL-only FOOTBALL_DATA is rejected the same way regardless of how moderate the resulting Model % looks",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixture={home:"Moreirense FC",away:"CS Marítimo",homeId:2010,awayId:2011,competitionCode:"PPL",seasonStart:"2026",utcDate:"2026-09-14T17:00:00Z"};
  // Representative synthetic shape — real historical data not recoverable.
  const rawContext=totalOnly(2010,"Moreirense FC",20,22,24,2011,"CS Marítimo",20,20,22);
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false,"TOTAL-only must be rejected even when the resulting probabilities look unremarkable, not just in extreme cases");
  assert.equal(result.baseContext.standings,null);
  db.close();
});

test("Villarreal-Real Betis: a WIN outcome is not grounds to keep an incorrectly-selected source — only the context-selection mechanism is checked",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixture={home:"Villarreal CF",away:"Real Betis Balompié",homeId:94,awayId:90,competitionCode:"PD",seasonStart:"2026",utcDate:"2026-09-14T19:00:00Z"};
  // Representative synthetic shape — real historical data not recoverable.
  // The fixture's real-world result (1:2, a WIN for the recommended side)
  // plays no role anywhere in this test: resolveTeamStrengthBaseline has no
  // knowledge of match outcomes, only of context maturity/venue-completeness.
  const rawContext=totalOnly(94,"Villarreal CF",18,24,20,90,"Real Betis Balompié",18,21,19);
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,false,"TOTAL-only source selection is rejected on its own merits, independent of the eventual match outcome");
  assert.equal(result.baseContext.standings,null);
  db.close();
});

test("no mature venue-specific source anywhere (TOTAL-only live, no SQLite, insufficient local history): Team Strength becomes unavailable, never fabricated from TOTAL",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixture={home:"Mirassol FC",away:"EC Vitória",homeId:4364,awayId:1782,competitionCode:"BSA",seasonStart:"2026",utcDate:"2026-09-14T19:00:00Z"};
  const rawContext=totalOnly(4364,"Mirassol FC",26,29,40,1782,"EC Vitória",26,25,37);
  // No SQLite baseline seeded at all for this competitionCode/season.
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.competitionBaseline,null);
  assert.equal(result.baseContext.standings,null,"TOTAL-only must be cleared, not kept as a last resort");
  const merged=mergeWithLocalHistory(result.baseContext,[],fixture); // no local history either
  assert.equal(merged.standings,null);
  assert.equal(teamStrengthModel(fixture,merged),null,"with no genuine venue-specific source anywhere, Team Strength must be null (WAIT) — never built from TOTAL-as-HOME/AWAY");
  db.close();
});

test("a genuinely complete source (real HOME/AWAY splits) continues to work exactly as before",()=>{
  const db=openHistoryDatabase(tempDb());
  const fixture={home:"Northside FC",away:"Southport United",homeId:501,awayId:502,competitionCode:"XX",seasonStart:"2025",utcDate:"2025-09-10T16:00:00Z"};
  const rawContext={standings:{standings:[
    {type:"TOTAL",table:[
      {team:{id:501,name:"Northside FC"},playedGames:10,goalsFor:15,goalsAgainst:10},
      {team:{id:502,name:"Southport United"},playedGames:10,goalsFor:12,goalsAgainst:11}
    ]},
    {type:"HOME",table:[{team:{id:501,name:"Northside FC"},playedGames:5,goalsFor:9,goalsAgainst:4}]},
    {type:"AWAY",table:[{team:{id:502,name:"Southport United"},playedGames:5,goalsFor:5,goalsAgainst:6}]}
  ]},finished:[],scheduled:[]};
  const result=resolveTeamStrengthBaseline(db,rawContext,fixture,alignContextTeamIds,fixture.utcDate);
  assert.equal(result.liveStandingsMature,true,"a source with genuine, mature venue splits must still be used directly, unaffected by this fix");
  assert.equal(result.competitionBaseline,null,"SQLite must not even be consulted when the live source is already complete");
  const merged=mergeWithLocalHistory(result.baseContext,[],fixture);
  const strength=teamStrengthModel(fixture,merged);
  // Attack/defence must be computed from the HOME/AWAY-specific rows (5
  // games, 9 GF / 5 games, 6 GA), not the TOTAL rows (10 games) — confirms
  // teamStrengthModel's own homeGames/awayGames selection is untouched.
  assert.equal(strength.lambdas.home>0&&strength.lambdas.away>0,true);
  db.close();
});
