import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPredictionStatistics, updatePredictionHistory } from "../src/statistics/predictionHistory.js";

function fourteenFixtures(){
  const categories=["VALUE","NEAR","WAIT","NO_BET"];
  return Array.from({length:14},(_,index)=>({id:String(index+1),utcDate:`2026-08-28T${String(10+index%10).padStart(2,"0")}:00:00Z`,home:`Home ${index}`,away:`Away ${index}`,competition:index<10?"League A":"League B",category:categories[index%4],dataQuality:40+index,stability:50+index,consensusScore:60,consensusProbability:{home:.45,draw:.3,away:.25},best:index%2?null:{market:"1X2",odds:2.2}}));
}

test("14 pre-match Model 1X2 сохраняются без требования odds и переживают restart",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-stats-14-")),"predictions.jsonl"),fixtures=fourteenFixtures();
  let stats=updatePredictionHistory(file,fixtures,[],"2026-08-27T12:00:00Z");
  assert.equal(stats.predictions,14);
  assert.equal(stats.categoryCounts.WAIT,3);
  assert.equal(loadPredictionStatistics(file).predictions,14);
  stats=updatePredictionHistory(file,fixtures,[],"2026-08-27T13:00:00Z");
  assert.equal(stats.predictions,14);
  assert.equal(fs.readFileSync(file,"utf8").trim().split(/\r?\n/).length,14);
});

test("смена provider fixture ID не дублирует тот же fixture/model/version",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-stats-provider-")),"predictions.jsonl"),fixture=fourteenFixtures()[0];
  updatePredictionHistory(file,[fixture],[],"2026-08-27T12:00:00Z");
  const stats=updatePredictionHistory(file,[{...fixture,id:"football-data-999"}],[],"2026-08-27T13:00:00Z");
  assert.equal(stats.predictions,1);
});

test("прогноз сохраняется один раз и после матча получает Brier и Log Loss",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-stats-")),"predictions.jsonl");
  const fixture={id:"7",utcDate:"2026-08-27T18:00:00Z",home:"Alpha",away:"Beta",competition:"League",category:"WAIT",dataQuality:50,stability:70,consensusScore:80,consensusProbability:{home:.5,draw:.3,away:.2},best:null};
  let stats=updatePredictionHistory(file,[fixture],[],"2026-08-27T12:00:00Z");
  assert.equal(stats.predictions,1);assert.equal(stats.completed,0);
  stats=updatePredictionHistory(file,[fixture],[{sourceFixtureId:"7",playedAt:"2026-08-27T18:00:00Z",homeTeam:{name:"Alpha"},awayTeam:{name:"Beta"},score:{fullTime:{home:2,away:1}},provenance:{source:"API_FOOTBALL"}}],"2026-08-27T21:00:00Z");
  assert.equal(stats.predictions,1);assert.equal(stats.completed,1);assert.equal(stats.accuracy,1);
  assert.ok(Number.isFinite(stats.brier));assert.ok(Number.isFinite(stats.logLoss));
  assert.equal(stats.categories.find(row=>row.name==="WAIT").completed,1);
  assert.equal(stats.leagues.find(row=>row.name==="League").completed,1);
  assert.equal(stats.bands.reduce((sum,row)=>sum+row.completed,0),1);
  assert.equal(fs.readFileSync(file,"utf8").trim().split(/\r?\n/).length,2);
});

test("прогноз после kickoff не записывается",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-stats-late-")),"predictions.jsonl");
  const stats=updatePredictionHistory(file,[{id:"8",utcDate:"2026-08-27T10:00:00Z",home:"A",away:"B",consensusProbability:{home:.4,draw:.3,away:.3}}],[],"2026-08-27T12:00:00Z");
  assert.equal(stats.predictions,0);
});

test("чужой provider ID не привязывает результат к неверному матчу",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-stats-id-")),"predictions.jsonl");
  const fixture={id:"9",utcDate:"2026-08-27T18:00:00Z",home:"Alpha",away:"Beta",competition:"League",category:"WAIT",consensusProbability:{home:.5,draw:.3,away:.2}};
  updatePredictionHistory(file,[fixture],[],"2026-08-27T12:00:00Z");
  const stats=updatePredictionHistory(file,[],[{sourceFixtureId:"9",playedAt:"2026-08-27T18:00:00Z",homeTeam:{name:"Wrong"},awayTeam:{name:"Teams"},score:{fullTime:{home:1,away:0}},provenance:{source:"FOOTBALL_DATA"}}],"2026-08-27T21:00:00Z");
  assert.equal(stats.completed,0);
});
