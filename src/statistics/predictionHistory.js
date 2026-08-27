import fs from "node:fs";
import path from "node:path";
import { sameTeamIdentity } from "../history/teamAliases.js";

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
  const resultById=new Map(results.map(row=>[String(row.fixtureId),row]));
  const mean=key=>results.length?results.reduce((sum,row)=>sum+Number(row[key]||0),0)/results.length:null;
  const summarize=rows=>{
    const graded=rows.map(row=>resultById.get(String(row.fixtureId))).filter(Boolean);
    return {predictions:rows.length,completed:graded.length,accuracy:graded.length?graded.filter(row=>row.topPickCorrect).length/graded.length:null};
  };
  const leagues=[...new Set(predictions.map(row=>row.competition||"Unknown"))].map(name=>({name,...summarize(predictions.filter(row=>(row.competition||"Unknown")===name))}));
  const bandFor=row=>{const max=Math.max(row.probability.home,row.probability.draw,row.probability.away)*100;return max>=80?"80%+":max>=70?"70–79%":max>=60?"60–69%":"<60%";};
  const bands=["<60%","60–69%","70–79%","80%+"].map(name=>({name,...summarize(predictions.filter(row=>bandFor(row)===name))}));
  return {predictions:predictions.length,completed:results.length,pending:Math.max(0,predictions.length-results.length),
    accuracy:results.length?results.filter(x=>x.topPickCorrect).length/results.length:null,brier:mean("brier"),logLoss:mean("logLoss"),
    draws:results.filter(x=>x.actual==="draw").length,actualDrawRate:results.length?results.filter(x=>x.actual==="draw").length/results.length:null,
    meanDrawProbability:predictions.length?predictions.reduce((sum,row)=>sum+row.probability.draw,0)/predictions.length:null,
    meanMaxProbability:predictions.length?predictions.reduce((sum,row)=>sum+Math.max(row.probability.home,row.probability.draw,row.probability.away),0)/predictions.length:null,
    leagues,bands,promotionTarget:300,
    categoryCounts:Object.fromEntries(["VALUE","NEAR","WAIT","NO_BET"].map(c=>[c,predictions.filter(x=>x.category===c).length]))};
}
export function loadPredictionStatistics(filePath){return buildPredictionStatistics(readEvents(filePath));}

export function updatePredictionHistory(filePath,results,history,now=new Date().toISOString()){
  const events=readEvents(filePath),predicted=new Set(events.filter(x=>x.type==="PREDICTION").map(x=>String(x.fixtureId))),graded=new Set(events.filter(x=>x.type==="RESULT").map(x=>String(x.fixtureId))),additions=[];
  for(const row of results||[]){
    if(predicted.has(String(row.id))||!validProbability(row.consensusProbability)||new Date(row.utcDate)<=new Date(now))continue;
    additions.push({schemaVersion:1,type:"PREDICTION",fixtureId:String(row.id),createdAt:now,kickoff:row.utcDate,home:row.home,away:row.away,
      competition:row.competition,competitionCode:row.competitionCode||null,probability:row.consensusProbability,category:row.category,
      dataQuality:row.dataQuality,stability:row.stability,consensus:row.consensusScore,
      market:row.best?{market:row.best.market,selection:row.best.selection,odds:row.best.odds}:null});
  }
  for(const prediction of [...events,...additions].filter(x=>x.type==="PREDICTION")){
    if(graded.has(String(prediction.fixtureId))||new Date(prediction.kickoff)>=new Date(now))continue;
    const match=historyMatch(prediction,history),actual=actualOutcome(match);if(!actual)continue;
    const p=Math.max(1e-12,Number(prediction.probability[actual])),top=Object.entries(prediction.probability).sort((a,b)=>b[1]-a[1])[0][0];
    const brier=["home","draw","away"].reduce((sum,key)=>sum+(prediction.probability[key]-(key===actual?1:0))**2,0);
    additions.push({schemaVersion:1,type:"RESULT",fixtureId:prediction.fixtureId,gradedAt:now,actual,score:match.score.fullTime,brier,logLoss:-Math.log(p),topPickCorrect:top===actual,resultSource:match.provenance?.source||match.provenance?.sources?.[0]||"LOCAL_HISTORY"});
    graded.add(String(prediction.fixtureId));
  }
  appendEvents(filePath,additions);return buildPredictionStatistics([...events,...additions]);
}
