import fs from "node:fs";
import path from "node:path";
import { asianSettlementOutcome, totalsSettlementOutcome } from "../engine/markets.js";
import { canonicalTeamName, sameTeamIdentity } from "../history/teamAliases.js";

export const MARKET_BET_MODEL_VERSION="production-market-v1";

function readEvents(filePath){try{return fs.readFileSync(filePath,"utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch{return [];}}
function appendEvents(filePath,events){if(!events.length)return;fs.mkdirSync(path.dirname(filePath),{recursive:true});fs.appendFileSync(filePath,`${events.map(JSON.stringify).join("\n")}\n`,"utf8");}
function finite(value){return value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value));}
function normalizedLine(value){return finite(value)?Number(value):null;}
function marketKey(row){
  const best=row.best||{},kickoff=String(row.utcDate||row.kickoff||"").slice(0,16);
  return [kickoff,canonicalTeamName(row.home),canonicalTeamName(row.away),row.category,best.market,best.label||best.selection||"",normalizedLine(best.line)??"",MARKET_BET_MODEL_VERSION].join("|");
}
function historyMatch(prediction,history){
  return (history||[]).filter(row=>{
    const delta=Math.abs(new Date(row.playedAt)-new Date(prediction.kickoff));
    return delta<=12*3600_000&&sameTeamIdentity(row.homeTeam?.name,prediction.home)&&sameTeamIdentity(row.awayTeam?.name,prediction.away);
  }).sort((a,b)=>Math.abs(new Date(a.playedAt)-new Date(prediction.kickoff))-Math.abs(new Date(b.playedAt)-new Date(prediction.kickoff)))[0]||null;
}
function sideFromSelection(selection){return /^(П1|Ф1|home)/i.test(selection)?"home":/^(П2|Ф2|away)/i.test(selection)?"away":null;}
function settle(prediction,match){
  const status=String(match.status||"").toUpperCase();
  if(["CANCELLED","CANCELED","ABANDONED"].includes(status))return "VOID";
  if(status==="POSTPONED")return null;
  if(status&&!['FINISHED','FT','AET','PEN'].includes(status))return null;
  const home=Number(match.score?.fullTime?.home),away=Number(match.score?.fullTime?.away);
  if(!Number.isFinite(home)||!Number.isFinite(away))return null;
  const {market,selection,line}=prediction;
  if(market==="1X2")return selection==="П1"?(home>away?"WIN":"LOSS"):selection==="X"?(home===away?"WIN":"LOSS"):selection==="П2"?(away>home?"WIN":"LOSS"):null;
  if(market==="AH"){const side=sideFromSelection(selection);if(!side||!finite(line))return null;return asianSettlementOutcome(home,away,side,Number(line)).replace("LOSE","LOSS");}
  if(market==="OU"){const side=/^(ТБ|over)/i.test(selection)?"over":/^(ТМ|under)/i.test(selection)?"under":null;if(!side||!finite(line))return null;return totalsSettlementOutcome(home+away,side,Number(line)).replace("LOSE","LOSS");}
  if(market==="DNB"){const side=sideFromSelection(selection);if(!side)return null;if(home===away)return "PUSH";return side==="home"?(home>away?"WIN":"LOSS"):(away>home?"WIN":"LOSS");}
  if(market==="BTTS"){const yes=/да|yes/i.test(selection),hit=home>0&&away>0;return yes===hit?"WIN":"LOSS";}
  return null;
}
function profit(settlement,odds){return ({WIN:Number(odds)-1,HALF_WIN:(Number(odds)-1)/2,PUSH:0,HALF_LOSS:-.5,LOSS:-1,VOID:0})[settlement];}
function summarize(predictions,resultByKey){
  const graded=predictions.map(row=>resultByKey.get(row.snapshotKey)).filter(Boolean),settled=graded.filter(row=>row.settlement!=="VOID");
  const unitProfit=settled.reduce((sum,row)=>sum+row.unitProfit,0);
  return {predictions:predictions.length,completed:graded.length,pending:predictions.length-graded.length,stake:settled.length,unitProfit,roi:settled.length?unitProfit/settled.length:null,averageOdds:settled.length?settled.reduce((sum,row)=>sum+Number(predictions.find(pred=>pred.snapshotKey===row.snapshotKey)?.odds||0),0)/settled.length:null,
    outcomes:Object.fromEntries(["WIN","HALF_WIN","PUSH","HALF_LOSS","LOSS","VOID"].map(key=>[key,graded.filter(row=>row.settlement===key).length]))};
}
export function buildMarketBetStatistics(events){
  const predictions=[...new Map(events.filter(row=>row.type==="MARKET_BET_PREDICTION"&&row.schemaVersion===2).map(row=>[row.snapshotKey,row])).values()];
  const resultByKey=new Map(events.filter(row=>row.type==="MARKET_BET_RESULT").map(row=>[row.snapshotKey,row]));
  const categories=Object.fromEntries(["VALUE","NEAR"].map(category=>[category,summarize(predictions.filter(row=>row.category===category),resultByKey)]));
  const byMarket=[...new Set(predictions.map(row=>row.market))].sort().map(market=>({market,...summarize(predictions.filter(row=>row.market===market),resultByKey)}));
  return {...summarize(predictions,resultByKey),categories,byMarket,ungradableLegacy:events.filter(row=>row.type==="MARKET_BET_PREDICTION"&&row.schemaVersion!==2).length};
}
export function loadMarketBetStatistics(filePath){return buildMarketBetStatistics(readEvents(filePath));}
export function updateMarketBetHistory(filePath,results,history,now=new Date().toISOString()){
  const events=readEvents(filePath),predicted=new Set(events.filter(row=>row.type==="MARKET_BET_PREDICTION").map(row=>row.snapshotKey)),graded=new Set(events.filter(row=>row.type==="MARKET_BET_RESULT").map(row=>row.snapshotKey)),additions=[];
  for(const row of results||[]){
    const best=row.best||{},snapshotKey=marketKey(row),selection=best.label||best.selection;
    if(!["VALUE","NEAR"].includes(row.category)||predicted.has(snapshotKey)||new Date(row.utcDate)<=new Date(now)||!selection||!finite(best.odds)||!finite(best.probability)||!finite(best.marketFair))continue;
    additions.push({schemaVersion:2,type:"MARKET_BET_PREDICTION",recordType:"PREDICTION",snapshotKey,modelVersion:MARKET_BET_MODEL_VERSION,fixtureId:String(row.id),createdAt:now,kickoff:row.utcDate,home:row.home,away:row.away,competition:row.competition,category:row.category,
      market:best.market,selection,line:normalizedLine(best.line),odds:Number(best.odds),bookmaker:best.bookmaker||null,modelProbability:Number(best.probability),fairMarketProbability:Number(best.marketFair),edge:Number(best.edge),ev:Number(best.ev),confidence:Number(best.confidence),dataQuality:Number(row.dataQuality),stability:Number(row.stability),fds:Number(best.fds),stakePercent:finite(best.stakePercent??row.stakePercent)?Number(best.stakePercent??row.stakePercent):null});
    predicted.add(snapshotKey);
  }
  for(const prediction of [...events,...additions].filter(row=>row.type==="MARKET_BET_PREDICTION"&&row.schemaVersion===2)){
    if(graded.has(prediction.snapshotKey)||new Date(prediction.kickoff)>=new Date(now))continue;
    const match=historyMatch(prediction,history);if(!match)continue;
    const settlement=settle(prediction,match);if(!settlement)continue;
    additions.push({schemaVersion:2,type:"MARKET_BET_RESULT",recordType:"RESULT",snapshotKey:prediction.snapshotKey,fixtureId:prediction.fixtureId,gradedAt:now,settlement,unitStake:settlement==="VOID"?0:1,unitProfit:profit(settlement,prediction.odds),score:match.score?.fullTime||null,resultSource:match.provenance?.source||match.provenance?.sources?.[0]||"LOCAL_HISTORY"});
    graded.add(prediction.snapshotKey);
  }
  appendEvents(filePath,additions);return buildMarketBetStatistics([...events,...additions]);
}
