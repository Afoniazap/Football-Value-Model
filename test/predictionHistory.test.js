import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updatePredictionHistory } from "../src/statistics/predictionHistory.js";

test("прогноз сохраняется один раз и после матча получает Brier и Log Loss",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-stats-")),"predictions.jsonl");
  const fixture={id:"7",utcDate:"2026-08-27T18:00:00Z",home:"Alpha",away:"Beta",competition:"League",category:"WAIT",dataQuality:50,stability:70,consensusScore:80,consensusProbability:{home:.5,draw:.3,away:.2},best:null};
  let stats=updatePredictionHistory(file,[fixture],[],"2026-08-27T12:00:00Z");
  assert.equal(stats.predictions,1);assert.equal(stats.completed,0);
  stats=updatePredictionHistory(file,[fixture],[{sourceFixtureId:"7",playedAt:"2026-08-27T18:00:00Z",homeTeam:{name:"Alpha"},awayTeam:{name:"Beta"},score:{fullTime:{home:2,away:1}},provenance:{source:"API_FOOTBALL"}}],"2026-08-27T21:00:00Z");
  assert.equal(stats.predictions,1);assert.equal(stats.completed,1);assert.equal(stats.accuracy,1);
  assert.ok(Number.isFinite(stats.brier));assert.ok(Number.isFinite(stats.logLoss));
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
