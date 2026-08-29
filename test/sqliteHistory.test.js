import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditHistoryIntegrity,databaseStats,getCompetitionSeasonMatches,getHeadToHead,
  getTeamAwayMatches,getTeamForm,getTeamHomeMatches,getTeamLastMatches,
  importHistoryMatches,openHistoryDatabase
} from "../src/history/sqliteHistory.js";

function tempDb(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-sqlite-")),"football.sqlite");}
function row({id="1",source="FOOTBALL_DATA",playedAt="2026-08-20T18:00:00Z",home="Alpha FC",away="Beta FC",hg=2,ag=1,sport="FOOTBALL"}={}){
  return {recordKey:`${source}:${id}`,sourceFixtureId:id,playedAt,status:"FINISHED",sport,competition:{code:"PL",name:"Premier League",season:"2025"},homeTeam:{id:"10",name:home},awayTeam:{id:"20",name:away},score:{fullTime:{home:hg,away:ag}},provenance:{source},fetchedAt:"2026-08-21T00:00:00Z"};
}

test("JSONL migration is idempotent and preserves multiple provider provenance",()=>{
  const file=tempDb(),db=openHistoryDatabase(file);
  assert.equal(importHistoryMatches(db,[row()]).inserted,1);
  assert.equal(importHistoryMatches(db,[row()]).duplicates,1);
  const second=row({id:"other",source:"API_FOOTBALL"});
  assert.equal(importHistoryMatches(db,[second]).inserted,0);
  const stats=databaseStats(db,file);
  assert.equal(stats.matches,1);assert.ok(stats.fileBytes>0);assert.ok(stats.indexAndDataBytes>0);
  const loaded=getTeamLastMatches(db,"Alpha FC","2026-08-21T00:00:00Z",20);
  assert.deepEqual(new Set(loaded[0].provenance.sources),new Set(["FOOTBALL_DATA","API_FOOTBALL"]));
  db.close();
});

test("queries are temporal-safe and support home, away, competition, H2H and form",()=>{
  const db=openHistoryDatabase(tempDb());
  importHistoryMatches(db,[
    row({id:"1",playedAt:"2026-08-10T18:00:00Z"}),
    row({id:"2",playedAt:"2026-08-12T18:00:00Z",home:"Gamma",away:"Alpha FC",hg:0,ag:0}),
    row({id:"3",playedAt:"2026-08-30T18:00:00Z",hg:9,ag:0})
  ]);
  const before="2026-08-20T00:00:00Z";
  assert.equal(getTeamLastMatches(db,"Alpha FC",before,20).length,2);
  assert.equal(getTeamHomeMatches(db,"Alpha FC",before,20).length,1);
  assert.equal(getTeamAwayMatches(db,"Alpha FC",before,20).length,1);
  assert.equal(getCompetitionSeasonMatches(db,"PL","2025",before).length,2);
  assert.equal(getCompetitionSeasonMatches(db,"PL","2025").length,3);
  assert.equal(getHeadToHead(db,"Alpha FC","Beta FC",before).length,1);
  assert.deepEqual(getTeamForm(db,"Alpha FC",before,5),{matches:2,points:4,ppg:2,goalsFor:2,goalsAgainst:1});
  assert.equal(auditHistoryIntegrity(db,before).futureLeakage,1);
  db.close();
});

test("integrity rejects wrong sport/missing score and detects provider score conflicts",()=>{
  const db=openHistoryDatabase(tempDb());
  const missing=row({id:"missing"});missing.score.fullTime.home=null;
  const report=importHistoryMatches(db,[row({id:"hockey",sport:"HOCKEY"}),missing,row()]);
  assert.equal(report.rejected.WRONG_SPORT,1);assert.equal(report.rejected.MISSING_SCORE,1);
  importHistoryMatches(db,[row({id:"conflict",source:"API_FOOTBALL",hg:1,ag:1})]);
  const integrity=auditHistoryIntegrity(db);
  assert.equal(integrity.duplicates,0);assert.equal(integrity.missingScores,0);assert.equal(integrity.conflictingProviderRecords,1);
  db.close();
});

test("SQLite history survives process-style close and reopen",()=>{
  const file=tempDb();let db=openHistoryDatabase(file);importHistoryMatches(db,[row()]);db.close();
  db=openHistoryDatabase(file);assert.equal(getTeamLastMatches(db,"Alpha FC","2026-08-21T00:00:00Z").length,1);db.close();
});

test("required history indexes exist",()=>{
  const db=openHistoryDatabase(tempDb()),names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row=>row.name));
  for(const name of ["idx_matches_kickoff","idx_matches_competition_season","idx_matches_home_team_id","idx_matches_away_team_id","idx_matches_home_normalized","idx_matches_away_normalized","idx_matches_provider_fixture","idx_matches_source"])assert.ok(names.has(name),name);
  db.close();
});

test("senior SQLite query does not accept youth records through colliding provider IDs",()=>{
  const db=openHistoryDatabase(tempDb());
  importHistoryMatches(db,[row({id:"senior",home:"Liverpool FC"}),row({id:"youth",home:"Liverpool U18",away:"Middlesbrough U18"})]);
  const matches=getTeamLastMatches(db,{id:"10",name:"Liverpool FC"},"2026-08-21T00:00:00Z",20);
  assert.equal(matches.length,1);assert.equal(matches[0].homeTeam.name,"Liverpool FC");db.close();
});

test("known Plzen football identity rejects the old TheSportsDB hockey team ID",()=>{
  const file=tempDb(),db=openHistoryDatabase(file),hockey=row({id:"hockey-plzen",source:"THESPORTSDB",home:"Plzen",away:"Sparta Prague"});
  hockey.homeTeam.id="135076";
  const report=importHistoryMatches(db,[hockey]);
  assert.equal(report.rejected.IDENTITY_MISMATCH,1);assert.equal(databaseStats(db,file).matches,0);db.close();
});

test("confirmed provider identity excludes a same-name foreign club",()=>{
  const db=openHistoryDatabase(tempDb());
  const uganda=row({id:"uganda-nec",source:"THESPORTSDB",home:"NEC",away:"Express FC"});
  uganda.homeTeam.id="149935";
  const nijmegen=row({id:"nl-nec",source:"THESPORTSDB",home:"NEC Nijmegen",away:"Beta"});
  nijmegen.homeTeam.id="133760";
  importHistoryMatches(db,[uganda,nijmegen]);
  const matches=getTeamLastMatches(db,"NEC","2026-08-21T00:00:00Z",20);
  assert.equal(matches.length,1);
  assert.equal(matches[0].homeTeam.id,"133760");
  db.close();
});

test("team context excludes friendlies without deleting stored provenance",()=>{
  const file=tempDb(),db=openHistoryDatabase(file);
  const friendly=row({id:"friendly",home:"Alpha FC",playedAt:"2026-08-19T18:00:00Z"});friendly.competition={name:"Club Friendlies",season:"2025"};
  importHistoryMatches(db,[friendly,row({id:"league",home:"Alpha FC"})]);
  assert.equal(databaseStats(db,file).matches,2);
  assert.equal(getTeamLastMatches(db,"Alpha FC","2026-08-21T00:00:00Z",20).length,1);
  db.close();
});
