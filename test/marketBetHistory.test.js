import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMarketBetStatistics, updateMarketBetHistory } from "../src/statistics/marketBetHistory.js";

function file(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-market-history-")),"bets.jsonl");}
function bet(overrides={}){return {id:"1",utcDate:"2026-09-03T18:00:00Z",home:"Alpha",away:"Beta",competition:"League",category:"VALUE",dataQuality:70,stability:75,best:{market:"AH",label:"Ф1(-0.75)",line:-.75,odds:2,probability:.6,marketFair:.5,edge:10,ev:20,confidence:80,fds:75,bookmaker:"Book"},...overrides};}
function result(home,away){return [{playedAt:"2026-09-03T18:00:00Z",homeTeam:{name:"Alpha"},awayTeam:{name:"Beta"},score:{fullTime:{home,away}},status:"FINISHED",provenance:{source:"TEST"}}];}

test("market history is append-only, deduplicated and persistent",()=>{
  const target=file();
  let stats=updateMarketBetHistory(target,[bet()],[],"2026-09-03T12:00:00Z");
  assert.equal(stats.predictions,1);
  stats=updateMarketBetHistory(target,[bet()],[],"2026-09-03T13:00:00Z");
  assert.equal(stats.predictions,1);
  assert.equal(loadMarketBetStatistics(target).predictions,1);
});

test("quarter AH grading preserves half win and unit profit",()=>{
  const target=file();
  updateMarketBetHistory(target,[bet()],[],"2026-09-03T12:00:00Z");
  const stats=updateMarketBetHistory(target,[],result(1,0),"2026-09-03T21:00:00Z");
  assert.equal(stats.outcomes.HALF_WIN,1);
  assert.equal(stats.unitProfit,.5);
  assert.equal(stats.categories.VALUE.roi,.5);
});

test("quarter OU, losses and temporal safety are graded exactly",()=>{
  const target=file(),under=bet({id:"2",category:"NEAR",best:{...bet().best,market:"OU",label:"ТМ 1.25",line:1.25,odds:2}});
  updateMarketBetHistory(target,[under],[],"2026-09-03T12:00:00Z");
  let stats=updateMarketBetHistory(target,[],result(1,0),"2026-09-03T21:00:00Z");
  assert.equal(stats.outcomes.HALF_WIN,1);
  stats=updateMarketBetHistory(target,[bet({id:"late"})],[],"2026-09-03T19:00:00Z");
  assert.equal(stats.predictions,1);
});

test("WAIT and incomplete market snapshots are not stored",()=>{
  const target=file();
  const stats=updateMarketBetHistory(target,[bet({category:"WAIT"}),bet({id:"bad",best:{...bet().best,marketFair:null}})],[],"2026-09-03T12:00:00Z");
  assert.equal(stats.predictions,0);
});

test("market grading covers ML, integer pushes, half loss, loss and void",()=>{
  const cases=[
    [{market:"1X2",label:"П1",line:null},2,1,"WIN",1],
    [{market:"AH",label:"Ф1(-1)",line:-1},1,0,"PUSH",0],
    [{market:"AH",label:"Ф1(+0.75)",line:.75},0,1,"HALF_LOSS",-.5],
    [{market:"OU",label:"ТБ 2.5",line:2.5},1,0,"LOSS",-1],
    [{market:"OU",label:"ТБ 2",line:2},1,1,"PUSH",0]
  ];
  for(const [market,home,away,expected,expectedProfit] of cases){
    const target=file(),row=bet({best:{...bet().best,...market}});
    updateMarketBetHistory(target,[row],[],"2026-09-03T12:00:00Z");
    const stats=updateMarketBetHistory(target,[],result(home,away),"2026-09-03T21:00:00Z");
    assert.equal(stats.outcomes[expected],1);
    assert.equal(stats.unitProfit,expectedProfit);
  }
  const target=file();
  updateMarketBetHistory(target,[bet()],[],"2026-09-03T12:00:00Z");
  const cancelled={...result(0,0)[0],status:"CANCELLED",score:{fullTime:{home:null,away:null}}};
  assert.equal(updateMarketBetHistory(target,[],[cancelled],"2026-09-03T21:00:00Z").outcomes.VOID,1);
});

test("VALUE and NEAR ROI stay separate; postponed and legacy records stay ungraded",()=>{
  const target=file(),near=bet({category:"NEAR",best:{...bet().best,market:"1X2",label:"П2",line:null}});
  updateMarketBetHistory(target,[bet({best:{...bet().best,market:"1X2",label:"П1",line:null}}),near],[],"2026-09-03T12:00:00Z");
  let stats=updateMarketBetHistory(target,[],result(2,1),"2026-09-03T21:00:00Z");
  assert.equal(stats.categories.VALUE.roi,1);
  assert.equal(stats.categories.NEAR.roi,-1);
  const postponed=file();updateMarketBetHistory(postponed,[bet()],[],"2026-09-03T12:00:00Z");
  const match={...result(0,0)[0],status:"POSTPONED"};
  assert.equal(updateMarketBetHistory(postponed,[],[match],"2026-09-03T21:00:00Z").completed,0);
  const legacy=file();fs.writeFileSync(legacy,JSON.stringify({type:"MARKET_BET_PREDICTION",schemaVersion:1,snapshotKey:"old"})+"\n");
  assert.equal(loadMarketBetStatistics(legacy).ungradableLegacy,1);
});
