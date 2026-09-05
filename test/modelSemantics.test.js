import test from "node:test";
import assert from "node:assert/strict";
import { analyseFixture } from "../src/engine/analyse.js";
import { decisionMetrics } from "../src/engine/markets.js";
import { consensus } from "../src/engine/models.js";
import { cardText, metricText } from "../src/ui/telegram.js";

const config={minDataQuality:70,minEdge:4,minEv:5,minConfidence:70,minStability:70};
const fixture={id:"semantics",homeId:1,awayId:2,home:"Alpha",away:"Beta",competition:"League",utcDate:"2026-09-10T18:00:00Z"};
const model=(name,probability,quality=60)=>({name,probability,quality});
const table=[
  {team:{id:1,name:"Alpha"},playedGames:8,goalsFor:16,goalsAgainst:8,points:16},
  {team:{id:2,name:"Beta"},playedGames:8,goalsFor:8,goalsAgainst:16,points:8}
];
const match=(id,homeId,awayId,homeGoals=2,awayGoals=1)=>({id,utcDate:`2026-08-${String(10+id).padStart(2,"0")}T18:00:00Z`,homeTeam:{id:homeId,name:`Team ${homeId}`},awayTeam:{id:awayId,name:`Team ${awayId}`},score:{fullTime:{home:homeGoals,away:awayGoals}}});
const context=finished=>({standings:{standings:[{type:"TOTAL",table},{type:"HOME",table},{type:"AWAY",table}]},finished,scheduled:[]});
const odds={agreement:70,bookmakers:[{name:"Book"}],best:{h2h:{home:{odds:4,bookmaker:"Book"},draw:{odds:4,bookmaker:"Book"},away:{odds:4,bookmaker:"Book"}},totals:{},spreads:{}},benchmark:{h2h:{bookmaker:"Book",home:4,draw:4,away:4,overround:-.25},totals:{},spreads:{}}};

test("0/1/2 models separate probability, agreement and coverage semantics",()=>{
  assert.equal(consensus([]),null);
  const one=consensus([model("one",{home:.5,draw:.3,away:.2})]);
  assert.deepEqual(one.probability,{home:.5,draw:.3,away:.2});
  assert.equal(one.agreement,null);assert.equal(one.modelsAvailable,1);assert.equal(one.modelCoverage,.5);
  const two=consensus([model("one",{home:.5,draw:.3,away:.2}),model("two",{home:.45,draw:.32,away:.23})]);
  assert.equal(two.modelsAvailable,2);assert.equal(two.modelCoverage,1);
  assert.equal(two.agreement,87);
});

test("missing Agreement and Stability contribute zero to Confidence without renormalization",()=>{
  const metrics=decisionMetrics({edge:10,ev:20},32,null,null,70,["a","b"]);
  assert.equal(metrics.confidence,20);
  assert.equal(metrics.confidenceParts.consensus,0);
  assert.equal(metrics.confidenceParts.stability,0);
  assert.equal(metrics.confidenceParts.dataQuality,9.6);
  assert.equal(metrics.confidenceParts.marketAgreement,7);
});

test("one-model candidate no longer receives mechanical agreement/stability and cannot remain NEAR on that support",()=>{
  const finished=[match(1,1,9),match(2,8,2)];
  const result=analyseFixture(fixture,context(finished),odds,config);
  assert.equal(result.modelsAvailable,1);assert.equal(result.modelCoverage,.5);
  assert.equal(result.modelAgreement,null);assert.equal(result.consensusScore,null);assert.equal(result.stability,null);
  assert.equal(result.best.confidence,18);
  assert.equal(result.category,"NO_BET");
});

test("two-model Agreement, Stability and Confidence retain the existing formulas exactly",()=>{
  const finished=[];
  for(let id=1;id<=4;id++)finished.push(match(id,1,10+id),match(id+4,20+id,2,1,1));
  const result=analyseFixture(fixture,context(finished),odds,config);
  assert.equal(result.modelsAvailable,2);assert.equal(result.modelCoverage,1);
  assert.equal(result.modelAgreement,result.consensusScore);
  assert.equal(result.stability,Math.round(result.consensusScore-result.stabilityV2.sciPenalty));
  const expected=decisionMetrics(result.best,result.dataQuality,result.consensusScore,result.stability,result.marketAgreement,result.redFlags);
  assert.equal(result.best.confidence,expected.confidence);
  assert.deepEqual(result.best.confidenceParts,expected.confidenceParts);
});

test("zero-model result and Telegram one-model diagnostics use explicit N/A semantics",()=>{
  const zero=analyseFixture(fixture,{standings:null,finished:[],scheduled:[]},null,config);
  assert.equal(zero.modelsAvailable,0);assert.equal(zero.modelCoverage,0);assert.equal(zero.modelAgreement,null);assert.equal(zero.stability,null);assert.equal(zero.category,"WAIT");
  const one=analyseFixture(fixture,context([match(1,1,9),match(2,8,2)]),odds,config);
  const card=cardText(one),stability=metricText("Stab",one);
  assert.match(card,/Model coverage: <b>1\/2<\/b>/);
  assert.match(card,/Model agreement: <b>N\/A — одна модель<\/b>/);
  assert.match(card,/Stability <b>N\/A — agreement не измерим<\/b>/);
  assert.match(stability,/Stability: N\/A — agreement не измерим/);
});
