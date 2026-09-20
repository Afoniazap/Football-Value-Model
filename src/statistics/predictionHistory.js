import fs from "node:fs";
import path from "node:path";
import { canonicalTeamName, sameTeamIdentity } from "../history/teamAliases.js";
import { settleMarket, profitForSettlement } from "./marketBetHistory.js";

export const PRODUCTION_MODEL_VERSION="production-baseline-v1";

function predictionKey(row){
  if(row.snapshotKey)return row.snapshotKey;
  const kickoff=String(row.kickoff||row.utcDate||"").slice(0,16);
  return `${kickoff}|${canonicalTeamName(row.home)}|${canonicalTeamName(row.away)}|${row.modelVersion||PRODUCTION_MODEL_VERSION}`;
}

function readEvents(filePath) {
  try { return fs.readFileSync(filePath,"utf8").split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)); }
  catch { return []; }
}
function appendEvents(filePath,events){
  if(!events.length)return;
  fs.mkdirSync(path.dirname(filePath),{recursive:true});
  fs.appendFileSync(filePath,`${events.map(event=>JSON.stringify(event)).join("\n")}\n`,"utf8");
}
function validProbability(p){const v=[p?.home,p?.draw,p?.away];return v.every(Number.isFinite)&&Math.abs(v.reduce((s,x)=>s+x,0)-1)<.02;}
function historyMatch(prediction,history){
  return (history||[]).filter(row=>{
    const delta=Math.abs(new Date(row.playedAt)-new Date(prediction.kickoff));
    const sources=[row.provenance?.source,...(row.provenance?.sources||[])];
    const ids=sources.includes("API_FOOTBALL")&&String(row.sourceFixtureId||"")===String(prediction.fixtureId);
    const names=sameTeamIdentity(row.homeTeam?.name,prediction.home)&&sameTeamIdentity(row.awayTeam?.name,prediction.away);
    return (ids||names)&&delta<=12*3600_000;
  }).sort((a,b)=>Math.abs(new Date(a.playedAt)-new Date(prediction.kickoff))-Math.abs(new Date(b.playedAt)-new Date(prediction.kickoff)))[0]||null;
}
function actualOutcome(match){const h=Number(match?.score?.fullTime?.home),a=Number(match?.score?.fullTime?.away);return !Number.isFinite(h)||!Number.isFinite(a)?null:h>a?"home":h<a?"away":"draw";}

export function buildPredictionStatistics(events){
  const predictions=events.filter(x=>x.type==="PREDICTION"),results=events.filter(x=>x.type==="RESULT");
  const predictionKeyByFixture=new Map(predictions.map(row=>[String(row.fixtureId),predictionKey(row)]));
  const resultByKey=new Map(results.map(row=>[row.snapshotKey||predictionKeyByFixture.get(String(row.fixtureId)),row]));
  const mean=key=>results.length?results.reduce((sum,row)=>sum+Number(row[key]||0),0)/results.length:null;
  const summarize=rows=>{
    const graded=rows.map(row=>resultByKey.get(predictionKey(row))).filter(Boolean);
    return {predictions:rows.length,completed:graded.length,accuracy:graded.length?graded.filter(row=>row.topPickCorrect).length/graded.length:null};
  };
  const leagues=[...new Set(predictions.map(row=>row.competition||"Unknown"))].map(name=>({name,...summarize(predictions.filter(row=>(row.competition||"Unknown")===name))}));
  const bandFor=row=>{const max=Math.max(row.probability.home,row.probability.draw,row.probability.away)*100;return max>=80?"80%+":max>=70?"70–79%":max>=60?"60–69%":"<60%";};
  const bands=["<60%","60–69%","70–79%","80%+"].map(name=>({name,...summarize(predictions.filter(row=>bandFor(row)===name))}));
  const categories=["VALUE","NEAR","WAIT","NO_BET"].map(name=>({name,...summarize(predictions.filter(row=>row.category===name))}));
  return {predictions:predictions.length,completed:results.length,pending:Math.max(0,predictions.length-results.length),
    accuracy:results.length?results.filter(x=>x.topPickCorrect).length/results.length:null,brier:mean("brier"),logLoss:mean("logLoss"),
    draws:results.filter(x=>x.actual==="draw").length,actualDrawRate:results.length?results.filter(x=>x.actual==="draw").length/results.length:null,
    meanDrawProbability:predictions.length?predictions.reduce((sum,row)=>sum+row.probability.draw,0)/predictions.length:null,
    meanMaxProbability:predictions.length?predictions.reduce((sum,row)=>sum+Math.max(row.probability.home,row.probability.draw,row.probability.away),0)/predictions.length:null,
    leagues,bands,categories,promotionTarget:300,
    categoryCounts:Object.fromEntries(["VALUE","NEAR","WAIT","NO_BET"].map(c=>[c,predictions.filter(x=>x.category===c).length]))};
}
export function loadPredictionStatistics(filePath){return buildPredictionStatistics(readEvents(filePath));}

export function updatePredictionHistory(filePath,results,history,now=new Date().toISOString()){
  const events=readEvents(filePath),existingPredictions=events.filter(x=>x.type==="PREDICTION");
  const predicted=new Set(existingPredictions.map(predictionKey));
  const predictionKeyByFixture=new Map(existingPredictions.map(row=>[String(row.fixtureId),predictionKey(row)]));
  const graded=new Set(events.filter(x=>x.type==="RESULT").map(x=>x.snapshotKey||predictionKeyByFixture.get(String(x.fixtureId))).filter(Boolean)),additions=[];
  for(const row of results||[]){
    const snapshotKey=predictionKey({...row,kickoff:row.utcDate,modelVersion:PRODUCTION_MODEL_VERSION});
    if(predicted.has(snapshotKey)||!validProbability(row.consensusProbability)||new Date(row.utcDate)<=new Date(now))continue;
    additions.push({schemaVersion:1,type:"PREDICTION",snapshotKey,modelVersion:PRODUCTION_MODEL_VERSION,fixtureId:String(row.id),createdAt:now,kickoff:row.utcDate,home:row.home,away:row.away,
      competition:row.competition,competitionCode:row.competitionCode||null,probability:row.consensusProbability,category:row.category,
      dataQuality:row.dataQuality,stability:row.stability,consensus:row.consensusScore,
      market:row.best?{market:row.best.market,selection:row.best.selection,odds:row.best.odds}:null});
  }
  for(const prediction of [...events,...additions].filter(x=>x.type==="PREDICTION")){
    const snapshotKey=predictionKey(prediction);
    if(graded.has(snapshotKey)||new Date(prediction.kickoff)>=new Date(now))continue;
    const match=historyMatch(prediction,history),actual=actualOutcome(match);if(!actual)continue;
    const p=Math.max(1e-12,Number(prediction.probability[actual])),top=Object.entries(prediction.probability).sort((a,b)=>b[1]-a[1])[0][0];
    const brier=["home","draw","away"].reduce((sum,key)=>sum+(prediction.probability[key]-(key===actual?1:0))**2,0);
    additions.push({schemaVersion:1,type:"RESULT",snapshotKey,modelVersion:prediction.modelVersion||PRODUCTION_MODEL_VERSION,fixtureId:prediction.fixtureId,gradedAt:now,actual,score:match.score.fullTime,brier,logLoss:-Math.log(p),topPickCorrect:top===actual,resultSource:match.provenance?.source||match.provenance?.sources?.[0]||"LOCAL_HISTORY"});
    graded.add(snapshotKey);
  }
  appendEvents(filePath,additions);return buildPredictionStatistics([...events,...additions]);
}

// ============================================================================
// Full-lifecycle snapshot/transition history (schemaVersion 2 events, same
// file as the PREDICTION/RESULT events above — this is the SAME persistence
// mechanism, extended: state.json is overwritten every refresh and the old
// PREDICTION event above only ever fires once per fixture (dedup key has no
// category/odds in it), so any category/odds/model change after the first
// refresh a fixture appears in was previously unrecoverable. These functions
// close that gap without touching the events/behaviour above.
// ============================================================================

function fixtureKey(row){
  const kickoff=String(row.kickoff||row.utcDate||"").slice(0,16);
  return `${kickoff}|${canonicalTeamName(row.home)}|${canonicalTeamName(row.away)}`;
}

// quality/(sum of qualities) — the weights consensus() actually applied,
// derived only from the already-computed quality values (never recomputed).
function modelWeights(teamStrength,form){
  const tsQ=Number(teamStrength?.quality),formQ=Number(form?.quality);
  const sum=(Number.isFinite(tsQ)?tsQ:0)+(Number.isFinite(formQ)?formQ:0);
  if(!sum)return null;
  return {teamStrength:Number.isFinite(tsQ)?tsQ/sum:null,form:Number.isFinite(formQ)?formQ/sum:null};
}

// Everything a viewer needs to reconstruct what the model showed at a given
// moment — see task spec section 2. `null` (not omission) for anything not
// available yet, so downstream comparisons never mistake "missing" for 0.
function snapshotFields(row){
  const b=row.best||null;
  const num=value=>Number.isFinite(Number(value))?Number(value):null;
  const prob=p=>validProbability(p)?{home:num(p.home),draw:num(p.draw),away:num(p.away)}:null;
  const teamStrength=(row.models||[]).find(m=>m.name==="Team Strength")||null;
  const form=(row.models||[]).find(m=>m.name==="Opponent-adjusted Form proxy")||null;
  const baseline=row.contextDiagnostic?.baseline||null;
  const localHistory=row.contextDiagnostic?.localHistory||null;
  return {
    fixtureId:String(row.id),
    competition:row.competition||null,competitionCode:row.competitionCode||null,
    home:row.home,away:row.away,kickoff:row.utcDate,
    market:b?.market??null,selection:b?.label??b?.selection??null,line:num(b?.line),
    odds:num(b?.odds),oddsProvider:b?.bookmaker??b?.bestBookmaker??null,
    modelProbability:num(b?.probability),fairOdds:num(b?.fairOdds),marketProbability:num(b?.marketFair),
    edge:num(b?.edge),ev:num(b?.ev),confidence:num(b?.confidence),
    // row.stability is the fixture's 1X2 Agreement-derived figure — it does
    // not describe an OU/AH candidate (Section 12/audit fix), so history
    // must record that honestly as N/A rather than the unrelated 1X2 value.
    dataQuality:num(row.dataQuality),
    stability:(b&&(b.market==="OU"||b.market==="AH"))?null:num(row.stability),
    fds:num(b?.fds),
    category:row.category,
    marketFreshness:row.marketFreshness??row.marketDiagnostic?.freshness??null,
    // TEAM STRENGTH / FORM — structured numbers straight off consensus.models,
    // never reconstructed from explanation text (task section 2, CRITICAL).
    teamStrengthProbability:prob(teamStrength?.probability),
    teamStrengthQuality:num(teamStrength?.quality),
    lambdaHome:num(teamStrength?.lambdas?.home),
    lambdaAway:num(teamStrength?.lambdas?.away),
    formProbability:prob(form?.probability),
    formQuality:num(form?.quality),
    // CONSENSUS
    consensusProbability:prob(row.consensusProbability),
    consensusWeights:modelWeights(teamStrength,form),
    // CONTEXT
    contextSource:row.contextDiagnostic?.source??null,
    baselineSource:baseline?.baselineSource??null,
    baselineFreshness:baseline?.freshness??null,
    baselineSample:num(baseline?.baselineSample),
    baselineTeams:num(baseline?.baselineTeams),
    localHistoryHomeMatches:num(localHistory?.homeMatches),
    localHistoryAwayMatches:num(localHistory?.awayMatches),
    temporalSafe:localHistory?.temporalSafe??null,
    // DIAGNOSTICS
    modelCoverage:num(row.modelCoverage),
    modelAgreement:num(row.modelAgreement),
    sci:num(row.sci?.score),
    redFlags:Array.isArray(row.redFlags)?row.redFlags:null,
    // MARKET
    marketProvider:row.marketSource??null,
    bookmakerCount:num(row.marketDiagnostic?.normalizedBookmakers)
  };
}

// The exact fields the task defines as "material" (section 5/6), extended
// with the four new SCALAR fields whose change is itself forensically
// significant (a context/baseline swap can move Model% at unchanged
// odds/category). Object/array-valued fields (probabilities, redFlags,
// weights) are deliberately excluded here: materialSignature's `.join("|")`
// would stringify them to "[object Object]", making every value compare
// equal instead of comparing content — a silent dedup bug, not a fix, so
// those fields are recorded on every material snapshot but don't themselves
// trigger one.
const MATERIAL_FIELDS=["market","selection","line","odds","modelProbability","edge","ev","confidence","dataQuality","stability","fds","category","lambdaHome","lambdaAway","baselineSource","baselineFreshness"];
function materialSignature(snapshot){return MATERIAL_FIELDS.map(field=>snapshot[field]).join("|");}

/**
 * Appends one SNAPSHOT event per fixture whenever something material changed
 * since its last recorded snapshot (never on an identical refresh — section
 * 6), plus a TRANSITION event whenever category itself changed (section 7).
 * FIRST SEEN (section 3) is simply the earliest SNAPSHOT per fixtureKey —
 * since nothing already written is ever rewritten, it is immutable by
 * construction. Fixtures whose kickoff has passed are skipped entirely
 * (section 9: prediction history becomes read-only at kickoff).
 */
export function updatePredictionSnapshots(filePath,results,now=new Date().toISOString()){
  const events=readEvents(filePath);
  const lastByFixture=new Map(),seenFixtures=new Set();
  for(const event of events){
    if(event.type!=="SNAPSHOT")continue;
    seenFixtures.add(event.fixtureKey);
    const prev=lastByFixture.get(event.fixtureKey);
    if(!prev||new Date(event.createdAt)>=new Date(prev.createdAt))lastByFixture.set(event.fixtureKey,event);
  }
  const additions=[];
  for(const row of results||[]){
    if(!row?.utcDate||new Date(row.utcDate)<=new Date(now))continue;
    const key=fixtureKey(row),fields=snapshotFields(row),signature=materialSignature(fields);
    const last=lastByFixture.get(key);
    if(last&&materialSignature(last)===signature)continue;
    const isFirstSeen=!seenFixtures.has(key);
    const snapshot={schemaVersion:2,type:"SNAPSHOT",fixtureKey:key,createdAt:now,scanId:now,isFirstSeen,...fields};
    additions.push(snapshot);
    if(last&&last.category!==fields.category){
      additions.push({schemaVersion:2,type:"TRANSITION",fixtureKey:key,fixtureId:fields.fixtureId,createdAt:now,
        fromCategory:last.category,toCategory:fields.category,reason:row.reason??null});
    }
    seenFixtures.add(key);
    lastByFixture.set(key,snapshot);
  }
  appendEvents(filePath,additions);
  return additions;
}

/**
 * Grades the LAST PRE-MATCH snapshot's actual selected market (section 10) —
 * reuses markets.js's own settlement logic via marketBetHistory.js's
 * settleMarket, so quarter-line AH/OU grading has exactly one implementation
 * in the codebase. Writes at most one SNAPSHOT_RESULT per fixture, ever.
 */
export function updateSnapshotGrading(filePath,history,now=new Date().toISOString()){
  const events=readEvents(filePath);
  const lastPreMatch=new Map(),graded=new Set();
  for(const event of events){
    if(event.type==="SNAPSHOT_RESULT"){graded.add(event.fixtureKey);continue;}
    if(event.type!=="SNAPSHOT"||new Date(event.createdAt)>=new Date(event.kickoff))continue;
    const prev=lastPreMatch.get(event.fixtureKey);
    if(!prev||new Date(event.createdAt)>=new Date(prev.createdAt))lastPreMatch.set(event.fixtureKey,event);
  }
  const additions=[];
  for(const [key,snapshot] of lastPreMatch){
    if(graded.has(key)||new Date(snapshot.kickoff)>=new Date(now))continue;
    if(!snapshot.market||!snapshot.selection||!Number.isFinite(snapshot.odds))continue;
    const match=historyMatch(snapshot,history);
    if(!match)continue;
    const settlement=settleMarket({market:snapshot.market,selection:snapshot.selection,line:snapshot.line},match);
    if(!settlement)continue;
    additions.push({schemaVersion:2,type:"SNAPSHOT_RESULT",fixtureKey:key,fixtureId:snapshot.fixtureId,gradedAt:now,
      finalScore:match.score?.fullTime||null,settlement,stakeUnits:settlement==="VOID"?0:1,
      profitLossUnits:profitForSettlement(settlement,snapshot.odds),
      market:snapshot.market,selection:snapshot.selection,line:snapshot.line,odds:snapshot.odds});
    graded.add(key);
  }
  appendEvents(filePath,additions);
  return additions;
}

function toLocalDate(iso){try{return new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Kyiv"}).format(new Date(iso));}catch{return null;}}

// Reporting-only labelling heuristic (section 4) — not a VALUE/NEAR/WAIT gate
// and never used by analyseFixture. Adjustable without touching model math.
const LATE_SIGNAL_HOURS_BEFORE_KICKOFF=6;

/**
 * Reassembles one timeline per fixture from the raw event stream: FIRST SEEN
 * → every snapshot → transitions → LAST PRE-MATCH → grading (section 12).
 */
export function buildFixtureTimelines(events){
  const byFixture=new Map();
  for(const event of events){
    if(event.type!=="SNAPSHOT")continue;
    if(!byFixture.has(event.fixtureKey))byFixture.set(event.fixtureKey,{
      fixtureKey:event.fixtureKey,fixtureId:event.fixtureId,home:event.home,away:event.away,
      competition:event.competition,competitionCode:event.competitionCode,kickoff:event.kickoff,
      snapshots:[],transitions:[],result:null
    });
    byFixture.get(event.fixtureKey).snapshots.push(event);
  }
  for(const event of events){
    if(event.type==="TRANSITION"&&byFixture.has(event.fixtureKey))byFixture.get(event.fixtureKey).transitions.push(event);
    if(event.type==="SNAPSHOT_RESULT"&&byFixture.has(event.fixtureKey))byFixture.get(event.fixtureKey).result=event;
  }
  for(const entry of byFixture.values()){
    entry.snapshots.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
    entry.transitions.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
    entry.first=entry.snapshots[0]||null;
    const preMatch=entry.snapshots.filter(s=>new Date(s.createdAt)<new Date(entry.kickoff));
    entry.lastPreMatch=preMatch.length?preMatch[preMatch.length-1]:null;
    entry.newToday=Boolean(entry.first&&toLocalDate(entry.first.createdAt)===toLocalDate(entry.kickoff));
    const lateWindowStart=entry.kickoff?new Date(new Date(entry.kickoff).getTime()-LATE_SIGNAL_HOURS_BEFORE_KICKOFF*3600_000):null;
    const firstIsLate=Boolean(entry.first&&lateWindowStart&&new Date(entry.first.createdAt)>=lateWindowStart);
    entry.lateSignal=firstIsLate&&entry.first.category==="VALUE"?"LATE_VALUE":firstIsLate&&entry.first.category==="NEAR"?"LATE_NEAR":null;
  }
  return [...byFixture.values()];
}

export function listHistoryDates(events){return [...new Set(buildFixtureTimelines(events).map(t=>toLocalDate(t.kickoff)).filter(Boolean))].sort().reverse();}

/** section 13 filters — date + category are the minimum required; league/market/result/NEW TODAY/LATE * layer on top. */
export function listHistoryMatches(events,{date,category,league,market,result,newToday,lateSignal}={}){
  let timelines=buildFixtureTimelines(events);
  if(date)timelines=timelines.filter(t=>toLocalDate(t.kickoff)===date);
  if(category&&category!=="ALL")timelines=timelines.filter(t=>(t.lastPreMatch?.category||t.first?.category)===category);
  if(league)timelines=timelines.filter(t=>t.competition===league);
  if(market)timelines=timelines.filter(t=>(t.lastPreMatch?.market||t.first?.market)===market);
  if(result)timelines=timelines.filter(t=>t.result?.settlement===result);
  if(newToday)timelines=timelines.filter(t=>t.newToday);
  if(lateSignal)timelines=timelines.filter(t=>t.lateSignal===lateSignal);
  return timelines.sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff));
}

function average(values){const v=values.filter(Number.isFinite);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}
function summarizeTimelines(timelines,pick){
  const graded=timelines.map(t=>t.result).filter(Boolean),settled=graded.filter(r=>r.settlement!=="VOID");
  const picked=timelines.map(pick).filter(Boolean);
  return {
    count:timelines.length,graded:graded.length,
    outcomes:Object.fromEntries(["WIN","HALF_WIN","PUSH","HALF_LOSS","LOSS","VOID"].map(key=>[key,graded.filter(r=>r.settlement===key).length])),
    unitProfit:settled.reduce((sum,r)=>sum+r.profitLossUnits,0),
    roi:settled.length?settled.reduce((sum,r)=>sum+r.profitLossUnits,0)/settled.length:null,
    averageOdds:average(picked.map(s=>s.odds)),averageModelProbability:average(picked.map(s=>s.modelProbability)),
    averageEdge:average(picked.map(s=>s.edge)),averageFds:average(picked.map(s=>s.fds))
  };
}

/** section 14/15 — a full day's audit, grouped by category, plus FIRST SEEN vs LAST PRE-MATCH and NEW TODAY / LATE * counts. */
export function buildDailyAudit(events,date){
  const timelines=listHistoryMatches(events,{date});
  const byCategory=cat=>timelines.filter(t=>(t.lastPreMatch?.category||t.first?.category)===cat);
  return {
    date,
    categories:Object.fromEntries(["VALUE","NEAR","WAIT","NO_BET"].map(cat=>[cat,summarizeTimelines(byCategory(cat),t=>t.lastPreMatch)])),
    firstSeenVsLastPreMatch:{
      firstSeen:summarizeTimelines(timelines,t=>t.first),
      lastPreMatch:summarizeTimelines(timelines,t=>t.lastPreMatch)
    },
    newToday:timelines.filter(t=>t.newToday).length,
    lateNear:timelines.filter(t=>t.lateSignal==="LATE_NEAR").length,
    lateValue:timelines.filter(t=>t.lateSignal==="LATE_VALUE").length
  };
}

export function loadHistoryEvents(filePath){return readEvents(filePath);}
