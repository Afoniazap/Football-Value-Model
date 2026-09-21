import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updatePredictionSnapshots, updateSnapshotGrading, loadHistoryEvents } from "../src/statistics/predictionHistory.js";

// Integration-level safety net for the season-scoped-backfill alias fix:
// proves the newly-curated TEAM_ALIAS_GROUPS entries only widen WHICH NAMES
// count as the same team, never WHEN a name-based match is accepted. The
// existing kickoff-window (12h) and home/away-orientation checks in
// historyMatch() are untouched by this task and must keep rejecting a
// same-pair match at the wrong date/venue exactly as before.

function file(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-identity-")),"predictions.jsonl");}
function fixture(overrides={}){
  return {
    id:"1",utcDate:"2026-08-31T19:15:00Z",home:"SC Braga",away:"Vitória SC",
    competition:"Primeira Liga",competitionCode:"PPL",category:"NEAR",reason:"Близок к порогу.",
    dataQuality:60,stability:70,
    best:{market:"1X2",label:"П1",line:null,odds:2.05,bookmaker:"Book",probability:.55,fairOdds:1.82,marketFair:.5,edge:5,ev:15,confidence:75,fds:47},
    ...overrides
  };
}
function historyRow({home,away,playedAt,hg,ag,competition="Primeira Liga",source="FOOTBALL_DATA"}){
  return {sourceFixtureId:"x",playedAt,homeTeam:{name:home},awayTeam:{name:away},status:"FINISHED",score:{fullTime:{home:hg,away:ag}},provenance:{source},competition:{name:competition}};
}

test("Sassuolo <-> US Sassuolo Calcio грейдится корректно end-to-end (реальный кейс из аудита)",()=>{
  const target=file();
  const fx=fixture({id:"2",home:"Bologna",away:"Sassuolo",competition:"Serie A",competitionCode:"SA",
    utcDate:"2026-09-06T16:00:00Z",best:{...fixture().best,label:"X"}});
  updatePredictionSnapshots(target,[fx],"2026-09-06T08:00:00Z");
  const additions=updateSnapshotGrading(target,
    [historyRow({home:"Bologna FC 1909",away:"US Sassuolo Calcio",playedAt:"2026-09-06T16:00:00Z",hg:2,ag:2,competition:"Serie A"})],
    "2026-09-06T20:00:00Z");
  assert.equal(additions.length,1);
  assert.equal(additions[0].settlement,"WIN","2:2 is a draw -- the 'X' (draw) selection wins");
});

test("SC Braga vs Vitória SC грейдится корректно end-to-end (реальный кейс из аудита)",()=>{
  const target=file();
  const fx=fixture();
  updatePredictionSnapshots(target,[fx],"2026-08-31T17:00:00Z");
  const additions=updateSnapshotGrading(target,
    [historyRow({home:"Sporting Clube de Braga",away:"Vitória SC",playedAt:"2026-08-31T19:15:00Z",hg:1,ag:0})],
    "2026-08-31T22:00:00Z");
  assert.equal(additions.length,1);
  assert.equal(additions[0].settlement,"WIN","home team (SC Braga, П1) won 1:0");
});

test("другой leg той же пары (7 дней раньше, стороны зеркальны) НЕ принимается, даже с новым alias",()=>{
  const target=file();
  const fx=fixture({home:"FC Iberia 1999",away:"Jagiellonia",competition:"UEFA Europa League",
    utcDate:"2026-08-27T16:00:00Z"});
  updatePredictionSnapshots(target,[fx],"2026-08-27T14:00:00Z");
  // The SQLite row that actually exists for this pair (Stage A audit finding):
  // leg 1, opposite venue, 171 hours before this prediction's own kickoff.
  const additions=updateSnapshotGrading(target,
    [historyRow({home:"Jagiellonia Białystok",away:"Iberia 1999",playedAt:"2026-08-20T13:00:00Z",hg:2,ag:0,competition:"UEFA Europa League"})],
    "2026-08-28T00:00:00Z");
  assert.equal(additions.length,0,"a same-pair match 171h away (the other leg) must not be accepted as this fixture's result");
});

test("обратный home/away той же пары в разумном окне НЕ принимается",()=>{
  const target=file();
  const fx=fixture({home:"Celta Vigo",away:"Osasuna",competition:"La Liga",competitionCode:"PD",
    utcDate:"2026-08-27T18:30:00Z"});
  updatePredictionSnapshots(target,[fx],"2026-08-27T16:00:00Z");
  // Sides reversed relative to the prediction, same kickoff time -- must be
  // rejected: home/away orientation is part of fixture identity, not just
  // "these two teams played".
  const additions=updateSnapshotGrading(target,
    [historyRow({home:"CA Osasuna",away:"RC Celta de Vigo",playedAt:"2026-08-27T18:30:00Z",hg:2,ag:1,competition:"Primera Division"})],
    "2026-08-27T21:00:00Z");
  assert.equal(additions.length,0,"a reversed-venue row for the same pair must never settle this fixture");
});

test("одинаковое короткое имя в разных competitions не даёт false match — Vitória (Бразилия) не грейдит Vitória SC (Португалия)",()=>{
  const target=file();
  const fx=fixture(); // SC Braga vs Vitória SC, Primeira Liga, 2026-08-31T19:15:00Z
  updatePredictionSnapshots(target,[fx],"2026-08-31T17:00:00Z");
  // A Brazilian "Vitória" result that happens to fall within the 12h window
  // and shares a raw team-name token, but is a completely different club,
  // competition and fixture (SC Braga never played this match at all).
  const additions=updateSnapshotGrading(target,
    [historyRow({home:"Flamengo",away:"Vitória",playedAt:"2026-08-31T21:00:00Z",hg:1,ag:0,competition:"Brazilian Serie A",source:"THESPORTSDB"})],
    "2026-09-01T00:00:00Z");
  assert.equal(additions.length,0,"a Brazilian Vitória match must never grade a Portuguese SC Braga vs Vitória SC prediction");
});

test("одинаковое короткое имя в разных competitions — обратный случай: Vitória SC (Португалия) не грейдит бразильский Vitória-фикстур",()=>{
  const target=file();
  const fx=fixture({home:"Mirassol FC",away:"EC Vitória",competition:"Campeonato Brasileiro Série A",
    utcDate:"2026-09-13T19:00:00Z"});
  updatePredictionSnapshots(target,[fx],"2026-09-13T17:00:00Z");
  const additions=updateSnapshotGrading(target,
    [historyRow({home:"Sporting Clube de Braga",away:"Vitória SC",playedAt:"2026-09-13T20:00:00Z",hg:2,ag:1,competition:"Primeira Liga"})],
    "2026-09-14T00:00:00Z");
  assert.equal(additions.length,0,"a Portuguese Vitória SC match must never grade a Brazilian Mirassol vs EC Vitória prediction");
});
