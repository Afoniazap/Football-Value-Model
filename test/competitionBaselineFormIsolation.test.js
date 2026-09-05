import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openHistoryDatabase, importHistoryMatches } from "../src/history/sqliteHistory.js";
import { buildCompetitionBaseline } from "../src/history/competitionBaseline.js";
import { mergeWithLocalHistory } from "../src/history/localHistory.js";
import { formModel } from "../src/engine/models.js";

function tempDb(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-form-isolation-")),"football.sqlite");}
function match(id,{home,homeId,away,awayId,playedAt,season="2024",hg=1,ag=0}){
  return {recordKey:`FOOTBALL_DATA:${id}`,sourceFixtureId:id,playedAt,status:"FINISHED",sport:"FOOTBALL",
    competition:{code:"PL",name:"PL",season},homeTeam:{id:homeId,name:home},awayTeam:{id:awayId,name:away},
    score:{fullTime:{home:hg,away:ag}},provenance:{source:"FOOTBALL_DATA"},fetchedAt:playedAt};
}

test("a genuine competition-wide baseline (current or previous season, all teams) never contaminates the Form model's recent-match window",()=>{
  const db=openHistoryDatabase(tempDb());
  // Whole-competition previous-season data for four teams, none of which are
  // the two fixture teams below — this is exactly the kind of all-teams
  // baseline data that must stay confined to context.standings.
  importHistoryMatches(db,[
    match("1",{home:"Gamma",homeId:"3",away:"Delta",awayId:"4",playedAt:"2024-09-01T18:00:00Z"}),
    match("2",{home:"Delta",homeId:"4",away:"Gamma",awayId:"3",playedAt:"2024-09-08T18:00:00Z"}),
    match("3",{home:"Gamma",homeId:"3",away:"Zeta",awayId:"6",playedAt:"2024-09-15T18:00:00Z"})
  ]);

  const baseline=buildCompetitionBaseline(db,"PL","2025","2025-09-10T00:00:00Z");
  assert.equal(baseline.baselineSource,"PREVIOUS_SEASON");
  const baselineTeamNames=baseline.standings.standings.find(s=>s.type==="TOTAL").table.map(row=>row.team.name);
  assert.deepEqual(new Set(baselineTeamNames),new Set(["Gamma","Delta","Zeta"]));

  // The fixture itself is between two entirely different teams with their own
  // (separately supplied) recent-match history — exactly what formModel reads.
  const fixture={id:"f1",homeId:"1",awayId:"2",home:"Alpha",away:"Beta",utcDate:"2025-09-10T18:00:00Z"};
  const ownRecentMatches=[
    {recordKey:"r1",playedAt:"2025-08-25T18:00:00Z",homeTeam:{id:"1",name:"Alpha"},awayTeam:{id:"9",name:"Other"},score:{fullTime:{home:2,away:0}}},
    {recordKey:"r2",playedAt:"2025-08-28T18:00:00Z",homeTeam:{id:"9",name:"Other"},awayTeam:{id:"1",name:"Alpha"},score:{fullTime:{home:1,away:1}}},
    {recordKey:"r3",playedAt:"2025-09-01T18:00:00Z",homeTeam:{id:"1",name:"Alpha"},awayTeam:{id:"8",name:"Other2"},score:{fullTime:{home:1,away:0}}},
    {recordKey:"r4",playedAt:"2025-09-03T18:00:00Z",homeTeam:{id:"8",name:"Other2"},awayTeam:{id:"1",name:"Alpha"},score:{fullTime:{home:0,away:2}}},
    {recordKey:"r5",playedAt:"2025-08-26T18:00:00Z",homeTeam:{id:"2",name:"Beta"},awayTeam:{id:"9",name:"Other"},score:{fullTime:{home:0,away:0}}},
    {recordKey:"r6",playedAt:"2025-08-29T18:00:00Z",homeTeam:{id:"9",name:"Other"},awayTeam:{id:"2",name:"Beta"},score:{fullTime:{home:1,away:2}}},
    {recordKey:"r7",playedAt:"2025-09-02T18:00:00Z",homeTeam:{id:"2",name:"Beta"},awayTeam:{id:"8",name:"Other2"},score:{fullTime:{home:1,away:1}}},
    {recordKey:"r8",playedAt:"2025-09-04T18:00:00Z",homeTeam:{id:"8",name:"Other2"},awayTeam:{id:"2",name:"Beta"},score:{fullTime:{home:0,away:1}}}
  ];

  const baseContext={standings:baseline.standings,finished:[],scheduled:[]};
  const merged=mergeWithLocalHistory(baseContext,ownRecentMatches,fixture);

  // The baseline's Gamma/Delta/Zeta matches must never appear in `finished` —
  // that field is what recentMatches()/formModel treat as "recent form".
  const finishedTeamNames=new Set(merged.finished.flatMap(m=>[m.homeTeam?.name,m.awayTeam?.name]));
  assert.ok(!finishedTeamNames.has("Gamma")&&!finishedTeamNames.has("Delta")&&!finishedTeamNames.has("Zeta"),
    "previous-season competition-baseline matches leaked into the Form model's recent-match window");

  const form=formModel(fixture,merged);
  assert.ok(form,"form model should still succeed from the fixture's own genuinely-recent matches");
  assert.equal(form.explanation.includes("PPG"),true);
  db.close();
});
