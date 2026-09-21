import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasSourceDate, importHistoryMatches, loadAllHistory, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { recentRefetchDates } from "../src/history/harvestDates.js";
import { updatePredictionSnapshots, updateSnapshotGrading, loadHistoryEvents } from "../src/statistics/predictionHistory.js";

// ============================================================================
// Confirmed bug: hasSourceDate(db, source, date) only proves "at least one
// match from this source was ever stored for this date" — app.js's history
// harvest loop treated that as "this date is fully loaded, never fetch it
// again". A same-day fetch that only caught the early kickoffs then
// permanently starved every later-finishing match on that date of a
// backfill, leaving predictions with a past kickoff stuck pending forever
// (confirmed: 129 pending, 29 for one recent date). The fix (recentRefetchDates,
// wired into app.js's updateLocalHistory loop) keeps hasSourceDate as a valid
// skip ONLY for dates outside the small recent-refetch window; within that
// window it is always re-queried. These tests exercise the safety net that
// makes always-re-querying correct: sqliteHistory's own INSERT OR IGNORE
// dedup (identityKey UNIQUE, match_sources PRIMARY KEY(source,providerFixtureId)).
// ============================================================================

function tempDb(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-backfill-")),"football.sqlite");}
function tempJsonl(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-backfill-")),"predictions.jsonl");}

function finishedRow({id,source="API_FOOTBALL",playedAt,home,away,hg,ag,status="FT"}){
  return {
    recordKey:`${source}:${id}`,sourceFixtureId:id,playedAt,status,sport:"FOOTBALL",
    competition:{code:"PL",name:"Premier League",season:"2026"},
    homeTeam:{id:"10",name:home},awayTeam:{id:"20",name:away},
    score:{fullTime:{home:hg,away:ag}},provenance:{source},fetchedAt:new Date().toISOString()
  };
}

test("1) частичная загрузка даты -> hasSourceDate(true) больше не блокирует дозагрузку внутри recent-window",()=>{
  const db=openHistoryDatabase(tempDb());
  const date="2026-09-20";
  // Same-day fetch only caught the early kickoff.
  importHistoryMatches(db,[finishedRow({id:"early",playedAt:"2026-09-20T12:00:00Z",home:"Alpha",away:"Beta",hg:1,ag:0})]);
  assert.ok(hasSourceDate(db,"API_FOOTBALL",date),"the date must already look \"loaded\" under the old has-any check");

  const forceRefetch=recentRefetchDates([date],2);
  assert.ok(forceRefetch.has(date),"a date this recent must be in the always-refetch window");

  // A later refresh re-queries the provider for the SAME date regardless of
  // hasSourceDate and finds the late kickoff that has since finished.
  const report=importHistoryMatches(db,[
    finishedRow({id:"early",playedAt:"2026-09-20T12:00:00Z",home:"Alpha",away:"Beta",hg:1,ag:0}),
    finishedRow({id:"late",playedAt:"2026-09-20T20:00:00Z",home:"Gamma",away:"Delta",hg:2,ag:2})
  ]);
  assert.equal(report.inserted,1,"only the genuinely new match must be inserted");
  assert.equal(report.duplicates,1,"the already-stored match must be recognised as a duplicate, not double-counted");
  assert.equal(loadAllHistory(db).length,2);
  db.close();
});

test("2) повторная загрузка одних и тех же данных не создаёт дублей",()=>{
  const db=openHistoryDatabase(tempDb());
  const row=finishedRow({id:"1",playedAt:"2026-09-20T18:00:00Z",home:"Alpha",away:"Beta",hg:1,ag:1});
  importHistoryMatches(db,[row]);
  importHistoryMatches(db,[row]);
  importHistoryMatches(db,[row]);
  assert.equal(loadAllHistory(db).length,1,"three identical imports must leave exactly one row");
  db.close();
});

test("3) несколько refresh одной даты постепенно докладывают недостающие матчи без потери ранее сохранённых",()=>{
  const db=openHistoryDatabase(tempDb());
  const m1=finishedRow({id:"1",playedAt:"2026-09-20T12:00:00Z",home:"Alpha",away:"Beta",hg:1,ag:0});
  const m2=finishedRow({id:"2",playedAt:"2026-09-20T15:00:00Z",home:"Gamma",away:"Delta",hg:0,ag:0});
  const m3=finishedRow({id:"3",playedAt:"2026-09-20T20:00:00Z",home:"Epsilon",away:"Zeta",hg:3,ag:1});
  importHistoryMatches(db,[m1]);
  assert.equal(loadAllHistory(db).length,1);
  importHistoryMatches(db,[m1,m2]);
  assert.equal(loadAllHistory(db).length,2);
  importHistoryMatches(db,[m1,m2,m3]);
  assert.equal(loadAllHistory(db).length,3,"each refresh must only add what is genuinely new");
  db.close();
});

test("4) поздно завершившийся матч корректно грейдит ранее зависший pending prediction",()=>{
  const dbFile=tempDb(),db=openHistoryDatabase(dbFile),predFile=tempJsonl();
  const fixture={
    id:"501",utcDate:"2026-09-20T20:00:00Z",home:"Epsilon",away:"Zeta",competition:"Premier League",competitionCode:"PL",
    category:"VALUE",reason:"Прошёл пороги.",dataQuality:70,stability:75,
    best:{market:"1X2",label:"П1",line:null,odds:2.1,bookmaker:"Book",probability:.55,fairOdds:1.82,marketFair:.5,edge:5,ev:15.5,confidence:80,fds:70}
  };
  // Snapshot taken before kickoff -> becomes the last pre-match state.
  updatePredictionSnapshots(predFile,[fixture],"2026-09-20T18:00:00Z");

  // Grading attempted right after kickoff, before the late match is in history -> stays pending.
  const firstAttempt=updateSnapshotGrading(predFile,loadAllHistory(db),"2026-09-20T22:00:00Z");
  assert.equal(firstAttempt.length,0,"must not fabricate a result before the match is actually in history");
  assert.equal(loadHistoryEvents(predFile).filter(e=>e.type==="SNAPSHOT_RESULT").length,0);

  // The fixed recent-window backfill now brings the late-finishing match in.
  importHistoryMatches(db,[finishedRow({id:"3",playedAt:"2026-09-20T20:00:00Z",home:"Epsilon",away:"Zeta",hg:3,ag:1})]);
  const secondAttempt=updateSnapshotGrading(predFile,loadAllHistory(db),"2026-09-21T06:00:00Z");
  assert.equal(secondAttempt.length,1);
  assert.equal(secondAttempt[0].settlement,"WIN","home team (П1) won 3:1");
  db.close();
});

test("5) postponed/cancelled/abandoned матч не превращается в фиктивный 0:0 или LOSS",()=>{
  const db=openHistoryDatabase(tempDb());
  for(const status of ["POSTPONED","CANCELLED","ABANDONED"]){
    const report=importHistoryMatches(db,[finishedRow({id:status,playedAt:"2026-09-20T18:00:00Z",home:"Alpha",away:"Beta",hg:0,ag:0,status})]);
    assert.equal(report.inserted,0,`${status} must never be stored as a finished result`);
    assert.equal(report.rejected.NOT_FINISHED,1);
  }
  assert.equal(loadAllHistory(db).length,0,"no postponed/cancelled/abandoned match may ever reach history as a fake result");
  db.close();
});

test("6) postponed матч оставляет prediction pending, а не VOID/LOSS задним числом",()=>{
  const dbFile=tempDb(),db=openHistoryDatabase(dbFile),predFile=tempJsonl();
  const fixture={
    id:"502",utcDate:"2026-09-20T18:00:00Z",home:"Alpha",away:"Beta",competition:"Premier League",competitionCode:"PL",
    category:"VALUE",reason:"Прошёл пороги.",dataQuality:70,stability:75,
    best:{market:"1X2",label:"П1",line:null,odds:2.1,bookmaker:"Book",probability:.55,fairOdds:1.82,marketFair:.5,edge:5,ev:15.5,confidence:80,fds:70}
  };
  updatePredictionSnapshots(predFile,[fixture],"2026-09-20T16:00:00Z");
  // The provider never reports a finished score for this fixture (it was postponed) -> never enters SQLite history.
  importHistoryMatches(db,[finishedRow({id:"pp",playedAt:"2026-09-20T18:00:00Z",home:"Alpha",away:"Beta",hg:0,ag:0,status:"POSTPONED"})]);
  const additions=updateSnapshotGrading(predFile,loadAllHistory(db),"2026-09-21T06:00:00Z");
  assert.equal(additions.length,0,"a postponed fixture must stay pending, never graded as a fake 0:0 result");
  db.close();
});
