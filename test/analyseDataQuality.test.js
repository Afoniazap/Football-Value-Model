import test from "node:test";
import assert from "node:assert/strict";
import { analyseFixture, calculateDataQuality } from "../src/engine/analyse.js";

const config={minDataQuality:70,minEdge:4,minEv:5,minConfidence:70,minStability:70};
const fixture={id:"dq",homeId:1,awayId:2,home:"Alpha",away:"Beta",utcDate:"2026-08-30T18:00:00Z"};
const match=(id,homeId,awayId)=>({id,utcDate:`2026-08-${10+id}T18:00:00Z`,homeTeam:{id:homeId,name:homeId===1?"Alpha":"Opponent"},awayTeam:{id:awayId,name:awayId===2?"Beta":"Opponent"},score:{fullTime:{home:1,away:0}}});

test("DQ breakdown раннего WAIT равен production DQ, а не фиксированным 42",()=>{
  const context={standings:null,finished:[match(1,1,9),match(2,8,2)],scheduled:[]};
  const result=analyseFixture(fixture,context,null,config);
  assert.equal(result.category,"WAIT");
  assert.equal(result.consensusProbability,undefined);
  assert.equal(result.dataQuality,10);
  assert.equal(Object.values(result.dataQualityV2).filter(Number.isFinite).slice(0,7).reduce((sum,value)=>sum+value,0),result.dataQuality);
  assert.equal(result.dataQualityV2.xgAvailable,false);
});

test("вынос DQ calculation сохраняет production scores для полного context",()=>{
  const table=[
    {team:{id:1,name:"Alpha"},playedGames:8,goalsFor:12,goalsAgainst:8,points:14},
    {team:{id:2,name:"Beta"},playedGames:8,goalsFor:9,goalsAgainst:10,points:10}
  ];
  const finished=[];
  for(let id=1;id<=4;id++)finished.push(match(id,1,9+id),match(id+4,9+id,2));
  const context={standings:{standings:[{type:"TOTAL",table},{type:"HOME",table},{type:"AWAY",table}]},finished,scheduled:[]};
  const expected=calculateDataQuality(context,null,{name:"form"},null);
  const result=analyseFixture(fixture,context,null,config);
  assert.equal(result.dataQuality,expected.dataQuality);
  assert.deepEqual(result.dataQualityV2,expected.dataQualityV2);
});
