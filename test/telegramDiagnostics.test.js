import test from "node:test";
import assert from "node:assert/strict";
import { dashboardText, cardText, metricText, statisticsText } from "../src/ui/telegram.js";

test("dashboard does not present provider failure as genuine zero fixtures",()=>{
  const text=dashboardText({
    loading:false,
    updatedAt:null,
    results:[],
    errors:["API-Football: DAILY LIMIT"],
    providers:{apiFootball:{dailyLimit:true,requests:1,cacheHits:0,staleHits:0,avoided:2}}
  });
  assert.match(text,/Матчей на 24 часа: <b>N\/A<\/b>/);
  assert.match(text,/API-Football: <b>DAILY LIMIT<\/b>/);
  assert.doesNotMatch(text,/Матчей на 24 часа: <b>0<\/b>/);
});

test("dashboard exposes degraded fixture fallback source",()=>{
  const text=dashboardText({
    loading:false,updatedAt:"2026-08-27T12:00:00Z",errors:["API-Football fixtures: DAILY_LIMIT"],results:[{category:"WAIT",dataQuality:42,marketAvailable:true,markets:[]}],
    providers:{apiFootball:{dailyLimit:true,requests:0,cacheHits:0,staleHits:0,avoided:1},fixtures:{status:"DEGRADED",source:"CACHED_STATE",reason:"DAILY_LIMIT"}}
  });
  assert.match(text,/Fixtures: <b>DEGRADED<\/b> · CACHED_STATE/);
  assert.doesNotMatch(text,/24[^\n]*<b>N\/A<\/b>/);
});

test("dashboard distinguishes quote coverage from calculated markets",()=>{
  const text=dashboardText({loading:false,updatedAt:"2026-08-27T10:00:00Z",errors:[],providers:{},results:[
    {category:"WAIT",marketAvailable:true,markets:[],dataQuality:42},
    {category:"NEAR",marketAvailable:true,markets:[{}],dataQuality:70}
  ]});
  assert.match(text,/Котировки найдены: <b>2\/2<\/b>/);
  assert.match(text,/Рынков рассчитано: <b>1\/2<\/b>/);
  assert.match(text,/Model 1X2: <b>0\/2<\/b>/);
});

test("dashboard separates context, model and market snapshot coverage",()=>{
  const text=dashboardText({loading:false,updatedAt:"2026-08-29T12:00:00Z",errors:[],providers:{marketSnapshots:{status:"OK",records:36,matched:2,fresh:0,stale:1,expired:1}},results:[
    {category:"WAIT",dataQuality:20,contextDiagnostic:{status:"OK"},consensusProbability:{home:.5,draw:.3,away:.2},markets:[],marketAvailable:false},
    {category:"WAIT",dataQuality:10,contextDiagnostic:{status:"UNAVAILABLE"},markets:[],marketAvailable:false}
  ]});
  assert.match(text,/Context готов: <b>1\/2<\/b> · Model 1X2: <b>1\/2<\/b>/);
  assert.match(text,/Market snapshots: <b>OK<\/b> · records 36 · matched 2 · fresh 0 · stale 1 · expired 1/);
});

test("dashboard and card label cached quotes as STALE with source timestamp",()=>{
  const fixture={category:"WAIT",id:"stale",home:"A",away:"B",competition:"Ligue 1",utcDate:"2026-08-30T18:00:00Z",marketAvailable:true,marketSource:"THE_ODDS_API",marketFreshness:"STALE",marketFetchedAt:"2026-08-29T08:12:00Z",marketDiagnostic:{normalizedBookmakers:2},markets:[],dataQuality:50,stability:50,consensusScore:50,redFlags:[]};
  const dashboard=dashboardText({loading:false,updatedAt:"2026-08-29T08:57:00Z",errors:[],providers:{},results:[fixture]});
  assert.match(dashboard,/FRESH 0 · STALE 1/);
  const card=cardText(fixture);
  assert.match(card,/STALE/);assert.match(card,/Котировки из кэша/);
});

test("WAIT card distinguishes an available quote from a missing model candidate",()=>{
  const fixture={id:"2",home:"A",away:"B",competition:"Ligue 1",utcDate:"2026-08-26T18:00:00Z",category:"WAIT",reason:"Недостаточно данных",best:null,marketAvailable:true,marketSource:"API_FOOTBALL",marketDiagnostic:{normalizedBookmakers:3,marketSelection:"BLOCKED_NO_MODEL_CONTEXT"},dataQuality:42,stability:35,consensusScore:0,redFlags:["Недостаточно данных модели"]};
  const text=cardText(fixture);
  assert.match(text,/Confidence <b>N\/A — нет модельного кандидата<\/b>/);
  assert.match(text,/Risk flags <b>1<\/b>/);
  assert.match(text,/Рынок: <b>API_FOOTBALL<\/b> · букмекеров 3/);
  assert.match(metricText("EV",fixture),/недостаточно реального competition\/team context/);
});

test("WAIT card keeps real model metrics visible without market odds",()=>{
  const text=cardText({id:"1",home:"A",away:"B",competition:"Ligue 1",utcDate:"2026-08-26T18:00:00Z",category:"WAIT",reason:"Нет рыночной линии",best:null,consensusProbability:{home:.51,draw:.27,away:.22},contextDiagnostic:{status:"OK",localHistory:{homeMatches:9,awayMatches:7}},dataQuality:54,stability:71,consensusScore:79,redFlags:["Нет рыночной линии"]});
  assert.match(text,/DQ <b>54\/100<\/b>/);
  assert.match(text,/Stability <b>71\/100<\/b>/);
  assert.match(text,/Consensus <b>79\/100<\/b>/);
  assert.match(text,/Confidence <b>N\/A — нет цены<\/b>/);
  assert.match(text,/Model 1X2: <b>П1 51\.0% · X 27\.0% · П2 22\.0%<\/b>/);
  assert.match(text,/Fair 1X2: <b>1\.96 · 3\.70 · 4\.55<\/b>/);
  assert.match(text,/Odds N\/A · Edge N\/A · EV N\/A/);
  assert.match(text,/Local history: <b>9\/7<\/b>/);
});

test("Model показывает реальные 1X2 без рыночной цены",()=>{
  const text=metricText("Model",{best:null,marketAvailable:false,consensusProbability:{home:.51,draw:.27,away:.22}});
  assert.match(text,/П1: 51\.0%/);assert.match(text,/X: 27\.0%/);assert.match(text,/П2: 22\.0%/);
});

test("DQ detail не превращает отсутствующий breakdown и xG в нули",()=>{
  const missing=metricText("DQ",{dataQuality:0,dataQualityV2:{}});
  assert.match(missing,/Выборка матчей: N\/A/);
  const explicit=metricText("DQ",{dataQuality:10,dataQualityV2:{sampleScore:0,freshnessScore:10,homeAwayScore:0,formScore:0,marketScore:0,xgScore:0,xgAvailable:false,squadScore:0}});
  assert.match(explicit,/Выборка матчей: \+0/);
  assert.match(explicit,/xG: N\/A/);
});

test("экран статистики компактен и показывает накопительные метрики",()=>{
  const text=statisticsText({predictions:120,completed:80,pending:40,accuracy:.55,brier:.61,logLoss:1.02,draws:20,promotionTarget:300,categoryCounts:{VALUE:2,NEAR:8,WAIT:70,NO_BET:40},bands:[{name:"<60%",completed:30,predictions:50,accuracy:.6}]});
  assert.match(text,/80\/300/);assert.match(text,/Accuracy: <b>55\.0%/);assert.ok(text.length<4096);
  assert.doesNotMatch(text,/<60%/);
});
