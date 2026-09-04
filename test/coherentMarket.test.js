import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMarkets } from "../src/engine/markets.js";

const matrix=[{h:1,a:0,p:.5},{h:0,a:0,p:.2},{h:0,a:1,p:.3}];
const books=[
  {name:"Coherent",h2h:{home:2,draw:3.5,away:4},totals:[{name:"Over",point:2.5,odds:1.9},{name:"Under",point:2.5,odds:1.9}],spreads:[{name:"Alpha",point:-.5,odds:1.9},{name:"Beta",point:.5,odds:1.9}]},
  {name:"BestHome",h2h:{home:2.2,draw:3.1,away:3.7},totals:[{name:"Over",point:2.5,odds:2.05},{name:"Under",point:2.5,odds:1.7}],spreads:[{name:"Alpha",point:-.5,odds:2.05},{name:"Beta",point:.5,odds:1.7}]}
];
const best={h2h:{home:{odds:2.2,bookmaker:"BestHome"},draw:{odds:3.5,bookmaker:"Coherent"},away:{odds:4,bookmaker:"Coherent"}},totals:{"Over|2.5":{name:"Over",point:2.5,odds:2.05,bookmaker:"BestHome"},"Under|2.5":{name:"Under",point:2.5,odds:1.9,bookmaker:"Coherent"}},spreads:{"Alpha|-0.5":{name:"Alpha",point:-.5,odds:2.05,bookmaker:"BestHome"},"Beta|0.5":{name:"Beta",point:.5,odds:1.9,bookmaker:"Coherent"}}};

test("fair benchmark is one lowest-overround bookmaker while executable odds stay best",()=>{
  const rows=evaluateMarkets({home:"Alpha",away:"Beta"},{scoreMatrix:matrix},{probability:{home:.5,draw:.2,away:.3}},{books,bookmakers:books,best});
  for(const label of ["П1","ТБ 2.5","Ф1(-0.5)"]){
    const row=rows.find(item=>item.label===label);
    assert.equal(row.bookmaker,"BestHome");
    assert.equal(row.benchmarkBookmaker,"Coherent");
    assert.equal(row.odds,label==="П1"?2.2:2.05);
  }
  const home=rows.find(row=>row.label==="П1");
  const expected=(1/2)/(1/2+1/3.5+1/4);
  assert.ok(Math.abs(home.marketFair-expected)<1e-12);
});

test("engine consumes the canonical precomputed benchmark without a second implementation",()=>{
  const canonical={h2h:{bookmaker:"Canonical",home:1.8,draw:4,away:5,overround:1/1.8+1/4+1/5-1},totals:{},spreads:{}};
  const rows=evaluateMarkets({home:"Alpha",away:"Beta"},{scoreMatrix:matrix},{probability:{home:.5,draw:.2,away:.3}},{bookmakers:books,best,benchmark:canonical});
  const home=rows.find(row=>row.label==="П1");
  assert.equal(home.benchmarkBookmaker,"Canonical");
  assert.ok(Math.abs(home.marketFair-((1/1.8)/(1/1.8+1/4+1/5)))<1e-12);
});

test("DNB remains available when complete H2H exists but no coherent benchmark exists",()=>{
  const rows=evaluateMarkets({home:"Alpha",away:"Beta"},{scoreMatrix:matrix},{probability:{home:.5,draw:.2,away:.3}},{bookmakers:[],best:{h2h:best.h2h,totals:{},spreads:{}},benchmark:{h2h:null,totals:{},spreads:{}}});
  assert.deepEqual(rows.filter(row=>row.market==="DNB").map(row=>row.label).sort(),["П1 DNB","П2 DNB"]);
  assert.equal(rows.some(row=>row.market==="1X2"),false);
});
