import test from "node:test";
import assert from "node:assert/strict";
import { dashboardText, cardText, listKeyboard, listText, metricText, sortListItems, statisticsText } from "../src/ui/telegram.js";

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

test("dashboard показывает Football-Data degradation без маскировки refresh",()=>{
  const text=dashboardText({loading:false,updatedAt:"2026-08-31T12:00:00Z",errors:[],results:[],providers:{footballData:{status:"DEGRADED",requests:1,cacheHits:2,staleHits:1,avoided:3}}});
  assert.match(text,/Football-Data: <b>DEGRADED<\/b> · req 1 · cache 3 · saved 3/);
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
  assert.match(text,/Model agreement: <b>79\/100<\/b>/);
  assert.match(text,/Confidence <b>N\/A — нет цены<\/b>/);
  assert.match(text,/🎯 <b>Модель:<\/b> <b>П1<\/b> · P <b>51%<\/b> · Кэф N\/A/);
  assert.match(text,/💰 Fair <b>1\.96<\/b> · Edge N\/A · EV N\/A/);
  assert.match(text,/Local history: <b>9\/7<\/b>/);
});

function pricedCard(overrides={}){
  return {id:"priced",home:"A",away:"B",competition:"League",utcDate:"2026-08-30T18:00:00Z",category:"WAIT",reason:"gates",marketAvailable:true,marketFreshness:"FRESH",dataQuality:60,stability:65,consensusScore:70,redFlags:[],best:{market:"1X2",label:"П1",odds:2.15,probability:.58,fairOdds:1.72,edge:11,ev:25,confidence:65,fds:60},...overrides};
}

test("верх карточки VALUE показывает ставку, цену и вероятность выбранного best",()=>{
  const text=cardText(pricedCard({category:"VALUE",dataQuality:75,stability:75,best:{...pricedCard().best,confidence:75,fds:80}}));
  assert.match(text,/✅ <b>Ставка:<\/b> <b>П1 @2\.15<\/b> · P <b>58%<\/b>/);
  assert.match(text,/💰 Fair <b>1\.72<\/b> · Edge <b>\+11 п\.п\.<\/b> · EV <b>\+25%<\/b>/);
});

test("Telegram VALUE Gates показывает thresholds из production config без UI defaults",()=>{
  const text=cardText(pricedCard({valueThresholds:{minEdge:9,minEv:12,minConfidence:73,minDataQuality:74,minStability:75}}));
  assert.match(text,/Edge: 11 п\.п\.\/9 п\.п\./);
  assert.match(text,/EV: 25%\/12%/);
  assert.match(text,/Conf: 65\/73/);
  assert.match(text,/DQ: 60\/74/);
  assert.match(text,/Stab: 65\/75/);
});

test("VALUE/NEAR list показывает информативный двухстрочный mobile summary",()=>{
  const fixture=pricedCard({home:"Barcelona",away:"Rayo Vallecano",utcDate:"2026-08-31T19:30:00Z",best:{...pricedCard().best,market:"OU",label:"ТМ 3.25",line:3.25,odds:2.52,probability:.62,edge:12.2,fds:48}});
  const text=listText("NEAR",[fixture]);
  assert.match(text,/Barcelona — Rayo Vallecano<\/b> · 31\.08 22:30\nТМ 3\.25 @2\.52 · Model 62% · Edge 12\.2 · FDS 48/);
  const button=listKeyboard([fixture]).inline_keyboard[0][0];
  assert.equal(button.callback_data,"card:priced");
  assert.doesNotMatch(button.text,/\n/);
});

test("NEAR list сортируется по probability выбранного best market, затем FDS и kickoff",()=>{
  const near=(id,probability,fds,utcDate)=>pricedCard({id,home:id,category:"NEAR",utcDate,best:{...pricedCard().best,probability,fds}});
  const items=[
    near("p693",.693,90,"2026-09-05T15:00:00Z"),
    near("p903",.903,70,"2026-09-05T15:00:00Z"),
    near("p942",.942,60,"2026-09-05T15:00:00Z"),
    near("p751",.751,80,"2026-09-05T15:00:00Z"),
    near("tie-low-fds",.693,40,"2026-09-05T12:00:00Z"),
    near("tie-late",.693,90,"2026-09-05T18:00:00Z"),
    near("invalid",undefined,999,"2026-09-05T10:00:00Z")
  ];
  const sorted=sortListItems("NEAR",items);
  assert.deepEqual(sorted.map(x=>x.id),[
    "p942","p903","p751","p693","tie-late","tie-low-fds","invalid"
  ]);
  const rendered=listText("NEAR",sorted);
  assert.ok(rendered.indexOf("p942")<rendered.indexOf("p903"));
  assert.ok(rendered.indexOf("p903")<rendered.indexOf("p751"));
  assert.ok(rendered.indexOf("p751")<rendered.indexOf("p693"));
  assert.deepEqual(sortListItems("VALUE",items).map(x=>x.id),items.map(x=>x.id));
});

test("WAIT и NO_BET не выдаются как ставка",()=>{
  for(const category of ["WAIT","NO_BET"]){
    const text=cardText(pricedCard({category}));
    assert.match(text,/🎯 <b>Кандидат:<\/b> <b>П1 @2\.15<\/b>/);
    assert.doesNotMatch(text,/<b>Ставка:<\/b>/);
  }
});

test("STALE best всегда помечен как ставка-кандидат",()=>{
  const text=cardText(pricedCard({category:"VALUE",marketFreshness:"STALE",best:{...pricedCard().best,market:"OU",label:"ТБ 2.5",odds:1.92,probability:.64,fairOdds:1.56,edge:12,ev:23}}));
  assert.match(text,/🎯 <b>Ставка-кандидат:<\/b> <b>ТБ 2\.5 @1\.92<\/b> ⚠️ STALE · P <b>64%<\/b>/);
  assert.doesNotMatch(text,/✅ <b>Ставка:<\/b>/);
});

test("AH presentation использует сторону и линию вероятности выбранного AH best",()=>{
  const text=cardText(pricedCard({best:{...pricedCard().best,market:"AH",label:"Ф1\(-0.5\)",line:-.5,odds:2.05,probability:.57,fairOdds:1.75,edge:8,ev:17}}));
  assert.match(text,/🎯 <b>Кандидат:<\/b> <b>П1 -0\.5 @2\.05<\/b> · P <b>57%<\/b>/);
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

test("экран статистики разделяет VALUE и NEAR market ROI",()=>{
  const text=statisticsText({}, {categories:{VALUE:{predictions:5,completed:4,roi:.125},NEAR:{predictions:8,completed:6,roi:-.05}},byMarket:[{market:"AH",predictions:3,completed:2,roi:.1}]});
  assert.match(text,/VALUE: 4\/5 · ROI 12\.5%/);
  assert.match(text,/NEAR: 6\/8 · ROI -5\.0%/);
  assert.match(text,/AH: 2\/3 · ROI 10\.0%/);
});
