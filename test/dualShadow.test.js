import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyseFixture } from "../src/engine/analyse.js";
import { buildDualShadow, loadDualShadowStatistics, updateDualShadowHistory } from "../src/shadow/dualShadow.js";
import { shadowMatchText, shadowStatisticsText } from "../src/ui/telegram.js";

const config={minDataQuality:70,minEdge:4,minEv:5,minConfidence:70,minStability:70};
const fixture={id:"provider-1",homeId:1,awayId:2,home:"Alpha FC",away:"Beta FC",competition:"League",competitionCode:"L1",utcDate:"2026-09-10T18:00:00Z"};
function context(){
  const total=[
    {team:{id:1,name:"Alpha FC"},playedGames:12,points:24,goalsFor:22,goalsAgainst:12,goalDifference:10},
    {team:{id:2,name:"Beta FC"},playedGames:12,points:17,goalsFor:15,goalsAgainst:15,goalDifference:0}
  ];
  const finished=[];
  for(let i=0;i<5;i++){
    finished.push({id:`h${i}`,utcDate:`2026-08-0${i+1}T12:00:00Z`,homeTeam:{id:1,name:"Alpha FC"},awayTeam:{id:10+i,name:`H${i}`},score:{fullTime:{home:2,away:1}}});
    finished.push({id:`a${i}`,utcDate:`2026-08-0${i+1}T15:00:00Z`,homeTeam:{id:20+i,name:`A${i}`},awayTeam:{id:2,name:"Beta FC"},score:{fullTime:{home:1,away:1}}});
  }
  return {standings:{standings:[{type:"TOTAL",table:total},{type:"HOME",table:total},{type:"AWAY",table:total}]},finished,scheduled:[]};
}
function odds(){return {agreement:70,bookmakers:[{}],best:{h2h:{home:{odds:2.1,bookmaker:"Book"},draw:{odds:3.2,bookmaker:"Book"},away:{odds:3.6,bookmaker:"Book"}},totals:{},spreads:{}}};}
function history(){return [{sourceFixtureId:"changed-provider-id",playedAt:fixture.utcDate,homeTeam:{name:"Alpha FC"},awayTeam:{name:"Beta FC"},score:{fullTime:{home:2,away:1}},provenance:{source:"FOOTBALL_DATA"}}];}

test("dual shadow сохраняет exact production parity и не меняет official decision",()=>{
  const production=analyseFixture(fixture,context(),odds(),config),before=structuredClone(production);
  const shadow=buildDualShadow(fixture,context(),production.consensusProbability);
  assert.ok(shadow?.challenger?.probability);assert.ok(shadow?.v2h?.probability);
  assert.deepEqual(production,before);
  for(const key of ["consensusProbability","dataQuality","stability","consensusScore","category","best","markets","reason"])assert.deepEqual(production[key],before[key]);
  assert.deepEqual(shadow.production.probability,production.consensusProbability);
});

test("один context создаёт три odds-independent prediction без HTTP",()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("unexpected HTTP");};
  try{
    const production=analyseFixture(fixture,context(),null,config),shadow=buildDualShadow(fixture,context(),production.consensusProbability);
    assert.deepEqual(Object.keys(shadow).filter(key=>["production","challenger","v2h"].includes(key)),["production","challenger","v2h"]);
    assert.equal(calls,0);
  }finally{globalThis.fetch=original;}
});

test("shadow append-safe, restart-safe, temporal-safe и settlement использует canonical identity",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-shadow-")),"dual-shadow.jsonl");
  const production=analyseFixture(fixture,context(),null,config),row={...production,shadow:buildDualShadow(fixture,context(),production.consensusProbability)};
  let stats=updateDualShadowHistory(file,[row],[],"2026-09-10T12:00:00Z");
  assert.equal(stats.predictions,1);assert.equal(stats.completed,0);
  stats=updateDualShadowHistory(file,[row],[],"2026-09-10T13:00:00Z");
  assert.equal(stats.predictions,1);assert.equal(loadDualShadowStatistics(file).predictions,1);
  stats=updateDualShadowHistory(file,[],history(),"2026-09-10T21:00:00Z");
  assert.equal(stats.completed,1);assert.equal(stats.production.completed,1);assert.equal(stats.challenger.completed,1);assert.equal(stats.v2h.completed,1);
  assert.equal(fs.readFileSync(file,"utf8").trim().split(/\r?\n/).length,2);
  const late={...row,id:"late",home:"Late A",away:"Late B",utcDate:"2026-09-09T18:00:00Z"};
  stats=updateDualShadowHistory(file,[late],[],"2026-09-10T21:00:00Z");
  assert.equal(stats.predictions,1);
});

test("shadow category и benchmark не подаются обратно в Production",()=>{
  const production=analyseFixture(fixture,context(),odds(),config),official={category:production.category,fair:production.best?.fairOdds,edge:production.best?.edge,ev:production.best?.ev,confidence:production.best?.confidence,fds:production.best?.fds};
  const combined={...production,shadow:buildDualShadow(fixture,context(),production.consensusProbability)};
  combined.shadow.challenger.shadowCategory="VALUE";
  assert.deepEqual({category:combined.category,fair:combined.best?.fairOdds,edge:combined.best?.edge,ev:combined.best?.ev,confidence:combined.best?.confidence,fds:combined.best?.fds},official);
});

test("Telegram shadow UI не показывает фиктивные 0.0% при пустой completed sample",()=>{
  const empty=shadowStatisticsText({completed:0,pending:3});
  assert.match(empty,/No completed live shadow fixtures yet/);assert.doesNotMatch(empty,/0\.0%/);
  const production=analyseFixture(fixture,context(),null,config),row={...production,shadow:buildDualShadow(fixture,context(),production.consensusProbability)};
  const card=shadowMatchText(row);assert.match(card,/Production/);assert.match(card,/Challenger/);assert.match(card,/V2 H/);assert.match(card,/только Production/);
});
