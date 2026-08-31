import fs from "node:fs";
import path from "node:path";
import { canonicalTeamName, sameTeamIdentity } from "../history/teamAliases.js";
import { buildChallenger, CHALLENGER_MODEL_VERSION } from "./challenger.js";
import { buildBaselineV2H, BASELINE_V2_H_MODEL_VERSION } from "./baselineV2H.js";

export const PRODUCTION_SHADOW_VERSION="production-baseline-v1";
export const STRONG_DISAGREEMENT_THRESHOLD=.10;
const KEYS=["home","draw","away"];

function valid(p){return KEYS.every(key=>Number.isFinite(p?.[key]))&&Math.abs(KEYS.reduce((sum,key)=>sum+p[key],0)-1)<.02;}
function fixtureKey(row){return `${String(row.kickoff||row.utcDate||"").slice(0,16)}|${canonicalTeamName(row.home)}|${canonicalTeamName(row.away)}`;}
function snapshotKey(row){return `${fixtureKey(row)}|dual-shadow-v1`;}
function read(file){try{return fs.readFileSync(file,"utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch{return [];}}
function append(file,rows){if(!rows.length)return;fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,`${rows.map(JSON.stringify).join("\n")}\n`,"utf8");}
function top(p){return [...KEYS].sort((a,b)=>p[b]-p[a])[0];}
function actual(match){const h=Number(match?.score?.fullTime?.home),a=Number(match?.score?.fullTime?.away);return !Number.isFinite(h)||!Number.isFinite(a)?null:h>a?"home":h<a?"away":"draw";}
function historyMatch(prediction,history){return (history||[]).filter(row=>{
  const close=Math.abs(new Date(row.playedAt)-new Date(prediction.kickoff))<=12*3600_000;
  return close&&sameTeamIdentity(row.homeTeam?.name,prediction.home)&&sameTeamIdentity(row.awayTeam?.name,prediction.away);
}).sort((a,b)=>Math.abs(new Date(a.playedAt)-new Date(prediction.kickoff))-Math.abs(new Date(b.playedAt)-new Date(prediction.kickoff)))[0]||null;}
function metrics(p,result){const probability=Math.max(1e-12,p[result]);return {brier:KEYS.reduce((sum,key)=>sum+(p[key]-(key===result?1:0))**2,0),logLoss:-Math.log(probability),topPickCorrect:top(p)===result};}
function gap(a,b){return valid(a)&&valid(b)?Math.max(...KEYS.map(key=>Math.abs(a[key]-b[key]))):null;}
function h2hBenchmark(row,observedAt){
  if(row.marketFreshness&&row.marketFreshness!=="FRESH")return null;
  const prices={};for(const item of row.markets||[]){if(item.market!=="1X2"||!Number.isFinite(item.odds))continue;if(item.label==="X")prices.draw=item.odds;else if(String(item.label).includes("1"))prices.home=item.odds;else if(String(item.label).includes("2"))prices.away=item.odds;}
  if(!KEYS.every(key=>Number.isFinite(prices[key])))return null;
  const raw=Object.fromEntries(KEYS.map(key=>[key,1/prices[key]])),sum=KEYS.reduce((n,key)=>n+raw[key],0);
  return {odds:prices,noVig:Object.fromEntries(KEYS.map(key=>[key,raw[key]/sum])),observedAt,source:row.marketSource||null,benchmarkOnly:true};
}

export function buildDualShadow(fixture,context,productionProbability){
  if(!valid(productionProbability))return null;
  const challenger=buildChallenger(fixture,context),v2h=buildBaselineV2H(fixture,context);
  if(!valid(challenger)||!valid(v2h))return null;
  return {
    production:{version:PRODUCTION_SHADOW_VERSION,probability:{...productionProbability}},
    challenger:{version:CHALLENGER_MODEL_VERSION,probability:challenger},
    v2h:{version:BASELINE_V2_H_MODEL_VERSION,probability:v2h},
    disagreement:{productionChallenger:gap(productionProbability,challenger),productionV2H:gap(productionProbability,v2h),challengerV2H:gap(challenger,v2h)}
  };
}

function average(values){const rows=values.filter(Number.isFinite);return rows.length?rows.reduce((a,b)=>a+b,0)/rows.length:null;}
function summarizeModel(predictions,results,key){
  const graded=results.filter(row=>row.metrics?.[key]);
  return {predictions:predictions.filter(row=>valid(row.models?.[key]?.probability)).length,completed:graded.length,accuracy:graded.length?graded.filter(row=>row.metrics[key].topPickCorrect).length/graded.length:null,brier:average(graded.map(row=>row.metrics[key].brier)),logLoss:average(graded.map(row=>row.metrics[key].logLoss)),meanDrawProbability:average(predictions.map(row=>row.models?.[key]?.probability?.draw)),meanMaxProbability:average(predictions.map(row=>row.models?.[key]?.probability&&Math.max(...KEYS.map(k=>row.models[key].probability[k]))))};
}
function summarySet(predictions,results){return {sample:results.length,production:summarizeModel(predictions,results,"production"),challenger:summarizeModel(predictions,results,"challenger"),v2h:summarizeModel(predictions,results,"v2h")};}
function grouped(predictions,results,group){
  const groupByKey=new Map(predictions.map(row=>[row.snapshotKey,group(row)]));
  return Object.fromEntries([...new Set(groupByKey.values())].map(name=>[name,summarySet(predictions.filter(row=>groupByKey.get(row.snapshotKey)===name),results.filter(row=>groupByKey.get(row.snapshotKey)===name))]));
}

export function buildDualShadowStatistics(events){
  const predictions=events.filter(row=>row.type==="SHADOW_PREDICTION"),results=events.filter(row=>row.type==="SHADOW_RESULT");
  const resultByKey=new Map(results.map(row=>[row.snapshotKey,row]));
  const completedPredictions=predictions.filter(row=>resultByKey.has(row.snapshotKey));
  const completedResults=completedPredictions.map(row=>resultByKey.get(row.snapshotKey));
  const band=row=>{const max=Math.max(...KEYS.map(key=>row.models.production.probability[key]));return max>=.8?"80%+":max>=.7?"70-79%":max>=.6?"60-69%":"<60%";};
  const strong=completedPredictions.filter(row=>Object.values(row.disagreement||{}).some(value=>value>STRONG_DISAGREEMENT_THRESHOLD));
  const strongResults=strong.map(row=>resultByKey.get(row.snapshotKey)).filter(Boolean);
  return {predictions:predictions.length,completed:results.length,pending:Math.max(0,predictions.length-results.length),progress:{completed:results.length,minimum:300,preferred:500},promotionReady:results.length>=300,status:results.length>=300?"REVIEW_READY":"OBSERVE",actualDrawRate:results.length?results.filter(row=>row.actual==="draw").length/results.length:null,...summarySet(predictions,results),byLeague:grouped(predictions,results,row=>row.competition||"UNKNOWN"),byBand:grouped(predictions,results,band),drawMatches:summarySet(completedPredictions.filter(row=>resultByKey.get(row.snapshotKey)?.actual==="draw"),completedResults.filter(row=>row.actual==="draw")),strongDisagreement:summarySet(strong,strongResults),byProductionCategory:grouped(predictions.filter(row=>["VALUE","NEAR"].includes(row.productionCategory)),results.filter(row=>["VALUE","NEAR"].includes(row.productionCategory)),row=>row.productionCategory||"OTHER")};
}
export function loadDualShadowStatistics(file){return buildDualShadowStatistics(read(file));}

export function updateDualShadowHistory(file,fixtures,history,now=new Date().toISOString()){
  const events=read(file),predictions=events.filter(row=>row.type==="SHADOW_PREDICTION"),known=new Set(predictions.map(row=>row.snapshotKey)),graded=new Set(events.filter(row=>row.type==="SHADOW_RESULT").map(row=>row.snapshotKey)),benchmarks=events.filter(row=>row.type==="SHADOW_MARKET_BENCHMARK"),additions=[];
  for(const row of fixtures||[]){
    if(!row.shadow||new Date(row.utcDate)<=new Date(now))continue;
    const key=snapshotKey(row);if(known.has(key))continue;
    additions.push({schemaVersion:1,type:"SHADOW_PREDICTION",snapshotKey:key,createdAt:now,kickoff:row.utcDate,fixtureId:String(row.id),home:row.home,away:row.away,competition:row.competition,competitionCode:row.competitionCode||null,productionCategory:row.category,models:row.shadow,disagreement:row.shadow.disagreement,marketBenchmark:row.best?{odds:row.best.odds,market:row.best.market,selection:row.best.selection,benchmarkOnly:true}:null});known.add(key);
  }
  for(const row of fixtures||[]){
    if(!row.shadow||new Date(row.utcDate)<=new Date(now))continue;const key=snapshotKey(row),market=h2hBenchmark(row,now);if(!market)continue;
    const previous=[...benchmarks,...additions].filter(x=>x.type==="SHADOW_MARKET_BENCHMARK"&&x.snapshotKey===key).at(-1);
    if(previous&&KEYS.every(side=>previous.closingCandidate?.odds?.[side]===market.odds[side]))continue;
    additions.push({schemaVersion:1,type:"SHADOW_MARKET_BENCHMARK",snapshotKey:key,observedAt:now,closingCandidate:market});
  }
  for(const prediction of [...predictions,...additions.filter(row=>row.type==="SHADOW_PREDICTION")]){
    if(graded.has(prediction.snapshotKey)||new Date(prediction.kickoff)>=new Date(now))continue;
    const match=historyMatch(prediction,history),result=actual(match);if(!result)continue;
    const closing=[...benchmarks,...additions].filter(row=>row.type==="SHADOW_MARKET_BENCHMARK"&&row.snapshotKey===prediction.snapshotKey&&new Date(row.observedAt)<new Date(prediction.kickoff)).at(-1)?.closingCandidate||null;
    additions.push({schemaVersion:1,type:"SHADOW_RESULT",snapshotKey:prediction.snapshotKey,gradedAt:now,fixtureId:prediction.fixtureId,home:prediction.home,away:prediction.away,competition:prediction.competition,productionCategory:prediction.productionCategory,actual:result,score:match.score.fullTime,metrics:{production:metrics(prediction.models.production.probability,result),challenger:metrics(prediction.models.challenger.probability,result),v2h:metrics(prediction.models.v2h.probability,result)},marketBenchmark:closing?{closingNoVig:closing.noVig,observedAt:closing.observedAt,source:closing.source,benchmarkOnly:true}:null,clvBenchmark:null,resultSource:match.provenance?.source||match.provenance?.sources?.[0]||"LOCAL_HISTORY"});graded.add(prediction.snapshotKey);
  }
  append(file,additions);return buildDualShadowStatistics([...events,...additions]);
}
