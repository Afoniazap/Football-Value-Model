import test from "node:test";
import assert from "node:assert/strict";
import { dashboardText, cardText, metricText } from "../src/ui/telegram.js";

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

test("dashboard distinguishes quote coverage from calculated markets",()=>{
  const text=dashboardText({loading:false,updatedAt:"2026-08-27T10:00:00Z",errors:[],providers:{},results:[
    {category:"WAIT",marketAvailable:true,markets:[],dataQuality:42},
    {category:"NEAR",marketAvailable:true,markets:[{}],dataQuality:70}
  ]});
  assert.match(text,/Котировки найдены: <b>2\/2<\/b>/);
  assert.match(text,/Рынков рассчитано: <b>1\/2<\/b>/);
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
  const text=cardText({id:"1",home:"A",away:"B",competition:"Ligue 1",utcDate:"2026-08-26T18:00:00Z",category:"WAIT",reason:"Нет рыночной линии",best:null,dataQuality:54,stability:71,consensusScore:79,redFlags:["Нет рыночной линии"]});
  assert.match(text,/DQ <b>54\/100<\/b>/);
  assert.match(text,/Stability <b>71\/100<\/b>/);
  assert.match(text,/Consensus <b>79\/100<\/b>/);
  assert.match(text,/Confidence <b>N\/A — нет цены<\/b>/);
});
