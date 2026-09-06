import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  updatePredictionSnapshots, updateSnapshotGrading, loadHistoryEvents,
  buildFixtureTimelines, listHistoryDates, listHistoryMatches, buildDailyAudit
} from "../src/statistics/predictionHistory.js";

function file(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-snapshots-")),"predictions.jsonl");}
function fixture(overrides={}){
  return {
    id:"1",utcDate:"2026-09-06T18:00:00Z",home:"Barcelona",away:"Valencia",
    competition:"La Liga",competitionCode:"PD",category:"NEAR",reason:"Близок к порогу.",
    dataQuality:60,stability:70,
    best:{market:"OU",label:"ТМ 3.5",line:3.5,odds:2.05,bookmaker:"Book",probability:.847,fairOdds:1.18,marketFair:.5,edge:31.2,ev:70,confidence:75,fds:47},
    ...overrides
  };
}
function historyRow(home,away,playedAt,hg,ag){
  return {sourceFixtureId:"1",playedAt,homeTeam:{name:home},awayTeam:{name:away},status:"FINISHED",score:{fullTime:{home:hg,away:ag}},provenance:{source:"TEST"}};
}

test("1. first seen сохраняется и не перезаписывается",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:00:00Z");
  updatePredictionSnapshots(target,[fixture({category:"VALUE"})],"2026-09-06T09:00:00Z");
  const events=loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT");
  const first=events.find(e=>e.isFirstSeen);
  assert.equal(events.filter(e=>e.isFirstSeen).length,1,"exactly one snapshot must ever be flagged first-seen");
  assert.equal(first.createdAt,"2026-09-06T08:00:00Z");
  assert.equal(first.category,"NEAR","the first-seen event's own fields must never be rewritten by later refreshes");
});

test("2. identical refresh не создаёт дубль",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:00:00Z");
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:30:00Z");
  assert.equal(loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT").length,1);
});

test("3. изменение odds создаёт новый snapshot",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:00:00Z");
  updatePredictionSnapshots(target,[fixture({best:{...fixture().best,odds:1.88}})],"2026-09-06T09:00:00Z");
  assert.equal(loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT").length,2);
});

test("4. изменение Model probability создаёт новый snapshot",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:00:00Z");
  updatePredictionSnapshots(target,[fixture({best:{...fixture().best,probability:.6}})],"2026-09-06T09:00:00Z");
  assert.equal(loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT").length,2);
});

test("5. NEAR -> VALUE сохраняет оба состояния",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture({category:"NEAR"})],"2026-09-06T08:00:00Z");
  updatePredictionSnapshots(target,[fixture({category:"VALUE",best:{...fixture().best,edge:40}})],"2026-09-06T09:00:00Z");
  const snapshots=loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT");
  assert.deepEqual(snapshots.map(e=>e.category),["NEAR","VALUE"]);
});

test("6. VALUE -> WAIT сохраняет transition с существующей reason",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture({category:"VALUE"})],"2026-09-06T08:00:00Z");
  updatePredictionSnapshots(target,[fixture({category:"WAIT",reason:"Нет доступных коэффициентов.",best:null})],"2026-09-06T09:00:00Z");
  const transition=loadHistoryEvents(target).find(e=>e.type==="TRANSITION");
  assert.ok(transition);
  assert.equal(transition.fromCategory,"VALUE");
  assert.equal(transition.toCategory,"WAIT");
  assert.equal(transition.reason,"Нет доступных коэффициентов.","reason must be the one analyseFixture already computed, not invented");
});

test("7. NEW TODAY определяется, когда first-seen и kickoff — один календарный день",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture({utcDate:"2026-09-06T18:00:00Z"})],"2026-09-06T08:00:00Z");
  const timeline=buildFixtureTimelines(loadHistoryEvents(target))[0];
  assert.equal(timeline.newToday,true);
});

test("8. LATE NEAR определяется, когда первый снимок появился незадолго до kickoff",()=>{
  const target=file();
  // kickoff 18:00, first seen 15:40 same day -> within the late window (<=6h before kickoff)
  updatePredictionSnapshots(target,[fixture({utcDate:"2026-09-06T18:00:00Z",category:"NEAR"})],"2026-09-06T15:40:00Z");
  const timeline=buildFixtureTimelines(loadHistoryEvents(target))[0];
  assert.equal(timeline.lateSignal,"LATE_NEAR");
});

test("8b. рано увиденный NEAR не помечается LATE",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture({utcDate:"2026-09-06T18:00:00Z",category:"NEAR"})],"2026-09-06T08:00:00Z");
  const timeline=buildFixtureTimelines(loadHistoryEvents(target))[0];
  assert.equal(timeline.lateSignal,null);
});

test("9. restart сохраняет историю (append-only, переживает повторное открытие файла)",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:00:00Z");
  // Simulate a process restart: nothing but the file on disk carries state across this call.
  updatePredictionSnapshots(target,[fixture({best:{...fixture().best,odds:1.9}})],"2026-09-06T09:00:00Z");
  assert.equal(loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT").length,2);
});

test("10. kickoff делает pre-match immutable — ни одного нового snapshot после начала матча",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture({utcDate:"2026-09-06T18:00:00Z"})],"2026-09-06T08:00:00Z");
  const before=loadHistoryEvents(target);
  updatePredictionSnapshots(target,[fixture({utcDate:"2026-09-06T18:00:00Z",category:"VALUE",best:{...fixture().best,odds:99}})],"2026-09-06T19:00:00Z");
  assert.deepEqual(loadHistoryEvents(target),before,"nothing may be written once now() is at or after kickoff");
});

test("11-15. grading: WIN, LOSS, PUSH, HALF_WIN, HALF_LOSS",()=>{
  const cases=[
    [{market:"1X2",label:"П1",line:null,odds:2},2,1,"WIN",1],
    [{market:"OU",label:"ТБ 2.5",line:2.5,odds:2},1,0,"LOSS",-1],
    [{market:"AH",label:"Ф1(-1)",line:-1,odds:2},1,0,"PUSH",0],
    [{market:"AH",label:"Ф1(-0.75)",line:-.75,odds:2},1,0,"HALF_WIN",.5],
    [{market:"AH",label:"Ф1(+0.75)",line:.75,odds:2},0,1,"HALF_LOSS",-.5]
  ];
  for(const [best,hg,ag,expectedSettlement,expectedProfit] of cases){
    const target=file();
    updatePredictionSnapshots(target,[fixture({utcDate:"2026-09-06T18:00:00Z",best:{...fixture().best,...best}})],"2026-09-06T08:00:00Z");
    updateSnapshotGrading(target,[historyRow("Barcelona","Valencia","2026-09-06T18:00:00Z",hg,ag)],"2026-09-06T21:00:00Z");
    const result=loadHistoryEvents(target).find(e=>e.type==="SNAPSHOT_RESULT");
    assert.equal(result.settlement,expectedSettlement,`${best.market} ${best.label}`);
    assert.equal(result.profitLossUnits,expectedProfit);
  }
});

test("16. фильтр истории по дате",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture({id:"1",home:"A",away:"B",utcDate:"2026-09-06T18:00:00Z"})],"2026-09-06T08:00:00Z");
  updatePredictionSnapshots(target,[fixture({id:"2",home:"C",away:"D",utcDate:"2026-09-07T18:00:00Z"})],"2026-09-07T08:00:00Z");
  const events=loadHistoryEvents(target);
  assert.deepEqual(listHistoryDates(events),["2026-09-07","2026-09-06"]);
  assert.equal(listHistoryMatches(events,{date:"2026-09-06"}).length,1);
});

test("17. фильтр истории по category",()=>{
  const target=file();
  updatePredictionSnapshots(target,[
    fixture({id:"1",home:"A",away:"B",category:"VALUE"}),
    fixture({id:"2",home:"C",away:"D",category:"NEAR"})
  ],"2026-09-06T08:00:00Z");
  const events=loadHistoryEvents(target);
  assert.equal(listHistoryMatches(events,{category:"VALUE"}).length,1);
  assert.equal(listHistoryMatches(events,{category:"ALL"}).length,2);
});

test("18. timeline матча собирает first/lastPreMatch/result",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture({category:"NEAR",best:{...fixture().best,odds:2.05}})],"2026-09-06T12:40:00Z");
  updatePredictionSnapshots(target,[fixture({category:"NEAR",best:{...fixture().best,odds:1.88}})],"2026-09-06T15:10:00Z");
  updatePredictionSnapshots(target,[fixture({category:"WAIT",best:{...fixture().best,odds:1.71,edge:20.4,fds:44},reason:"Ниже порога."})],"2026-09-06T17:20:00Z");
  updateSnapshotGrading(target,[historyRow("Barcelona","Valencia","2026-09-06T18:00:00Z",1,0)],"2026-09-06T21:00:00Z");
  const timeline=buildFixtureTimelines(loadHistoryEvents(target))[0];
  assert.equal(timeline.snapshots.length,3,"all three material states must be preserved, not just the latest");
  assert.equal(timeline.first.odds,2.05);
  assert.equal(timeline.first.category,"NEAR");
  assert.equal(timeline.lastPreMatch.odds,1.71);
  assert.equal(timeline.lastPreMatch.category,"WAIT");
  assert.equal(timeline.transitions.length,1);
  assert.ok(timeline.result,"OU 3.5 was graded against a 1-0 final score");
});

test("19. финальный результат не переписывает старый prediction",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:00:00Z");
  const before=loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT");
  updateSnapshotGrading(target,[historyRow("Barcelona","Valencia","2026-09-06T18:00:00Z",4,0)],"2026-09-06T21:00:00Z");
  const after=loadHistoryEvents(target).filter(e=>e.type==="SNAPSHOT");
  assert.deepEqual(after,before,"grading must only ever append a SNAPSHOT_RESULT, never touch a SNAPSHOT event");
});

test("20. отсутствующий результат не портит историю",()=>{
  const target=file();
  updatePredictionSnapshots(target,[fixture()],"2026-09-06T08:00:00Z");
  const before=loadHistoryEvents(target);
  const additions=updateSnapshotGrading(target,[],"2026-09-06T21:00:00Z");
  assert.equal(additions.length,0);
  assert.deepEqual(loadHistoryEvents(target),before);
});

test("daily audit разделяет категории и считает NEW TODAY / LATE NEAR / LATE VALUE",()=>{
  const target=file();
  updatePredictionSnapshots(target,[
    fixture({id:"1",home:"A",away:"B",category:"NEAR",utcDate:"2026-09-06T18:00:00Z"}),
    fixture({id:"2",home:"C",away:"D",category:"VALUE",utcDate:"2026-09-06T20:00:00Z",best:{...fixture().best,market:"1X2",label:"П1",line:null}})
  ],"2026-09-06T15:40:00Z");
  const audit=buildDailyAudit(loadHistoryEvents(target),"2026-09-06");
  assert.equal(audit.categories.NEAR.count,1);
  assert.equal(audit.categories.VALUE.count,1);
  assert.equal(audit.newToday,2);
  assert.equal(audit.lateNear,1);
  assert.equal(audit.lateValue,1);
});
