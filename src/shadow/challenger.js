import { buildScoreMatrix, clamp } from "../engine/utils.js";

export const CHALLENGER_MODEL_VERSION="CHALLENGER_MODEL_V1_CALIBRATED";
export const CHALLENGER_TEMPERATURE=1.175;

function tableRow(context,type,teamId){
  const table=context?.standings?.standings?.find(row=>row.type===type)?.table||[];
  return table.find(row=>row.team?.id===teamId)||null;
}
function matches(context){return context?.finished||context?.matches||[];}
function leagueRates(context){
  const rows=matches(context),total=rows.reduce((out,row)=>{
    const h=Number(row.score?.fullTime?.home),a=Number(row.score?.fullTime?.away);
    if(Number.isFinite(h)&&Number.isFinite(a)){out.home+=h;out.away+=a;out.count++;}
    return out;
  },{home:0,away:0,count:0});
  return total.count?{home:total.home/total.count,away:total.away/total.count}:{home:1.35,away:1.1};
}
function rate(goals,games,fallback){return Number(games)>0?Number(goals)/Number(games):fallback;}
function shrunk(raw,games,average,n=8){return (raw*Math.max(0,games)+average*n)/(Math.max(0,games)+n);}
function sideRates(context,teamId,type,forAvg,againstAvg){
  const total=tableRow(context,"TOTAL",teamId),split=tableRow(context,type,teamId),games=Number(split?.playedGames)||0;
  const totalGames=Number(total?.playedGames)||0;
  const rawFor=rate(split?.goalsFor,games,rate(total?.goalsFor,totalGames,(forAvg+againstAvg)/2));
  const rawAgainst=rate(split?.goalsAgainst,games,rate(total?.goalsAgainst,totalGames,(forAvg+againstAvg)/2));
  return {games,scored:shrunk(rawFor,games,forAvg),conceded:shrunk(rawAgainst,games,againstAvg)};
}
function recent(context,teamId,limit=6){
  return matches(context).filter(row=>row.homeTeam?.id===teamId||row.awayTeam?.id===teamId)
    .sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate)).slice(0,limit);
}
function formEffect(context,fixture){
  const score=teamId=>recent(context,teamId).reduce((out,row,index)=>{
    const home=row.homeTeam?.id===teamId,h=Number(row.score?.fullTime?.home),a=Number(row.score?.fullTime?.away);
    if(!Number.isFinite(h)||!Number.isFinite(a))return out;
    const gf=home?h:a,ga=home?a:h,w=.72**index;
    out.points+=(gf>ga?3:gf===ga?1:0)*w;out.gd+=(gf-ga)*w;out.weight+=w;return out;
  },{points:0,gd:0,weight:0});
  const h=score(fixture.homeId),a=score(fixture.awayId);
  const ppg=(h.weight?h.points/h.weight:1)-(a.weight?a.points/a.weight:1);
  const gd=(h.weight?h.gd/h.weight:0)-(a.weight?a.gd/a.weight:0);
  return clamp(ppg/3*.06+gd/4*.03,-.08,.08);
}
function eloEffect(context,fixture){
  const ratings=new Map(),initial=1500;
  for(const row of [...matches(context)].sort((a,b)=>new Date(a.utcDate)-new Date(b.utcDate))){
    const hId=row.homeTeam?.id,aId=row.awayTeam?.id,hg=Number(row.score?.fullTime?.home),ag=Number(row.score?.fullTime?.away);
    if(hId==null||aId==null||!Number.isFinite(hg)||!Number.isFinite(ag))continue;
    const hr=ratings.get(hId)||initial,ar=ratings.get(aId)||initial,expected=1/(1+10**((ar-(hr+65))/400));
    const actual=hg===ag ? 0.5 : (hg>ag?1:0),delta=20*(actual-expected);ratings.set(hId,hr+delta);ratings.set(aId,ar-delta);
  }
  const hr=ratings.get(fixture.homeId)||initial,ar=ratings.get(fixture.awayId)||initial;
  return clamp((1/(1+10**((ar-(hr+65))/400))-.5)*.5,-.18,.18);
}
function temperature(probability,t=CHALLENGER_TEMPERATURE){
  const values=[probability.home,probability.draw,probability.away].map(value=>Math.exp(Math.log(Math.max(1e-12,value))/t));
  const sum=values.reduce((a,b)=>a+b,0);return {home:values[0]/sum,draw:values[1]/sum,away:values[2]/sum};
}

export function buildChallenger(fixture,context){
  if(!tableRow(context,"TOTAL",fixture.homeId)||!tableRow(context,"TOTAL",fixture.awayId))return null;
  const league=leagueRates(context),home=sideRates(context,fixture.homeId,"HOME",league.home,league.away),away=sideRates(context,fixture.awayId,"AWAY",league.away,league.home);
  let lambdaHome=clamp(league.home*(home.scored/league.home)*(away.conceded/league.home),.25,3.2);
  let lambdaAway=clamp(league.away*(away.scored/league.away)*(home.conceded/league.away),.2,2.8);
  const form=formEffect(context,fixture);lambdaHome*=1+form;lambdaAway*=1-form;
  const matrix=buildScoreMatrix(lambdaHome,lambdaAway),raw={home:0,draw:0,away:0};
  for(const row of matrix)raw[row.h>row.a?"home":row.h===row.a?"draw":"away"]+=row.p;
  const elo=eloEffect(context,fixture),scores=[Math.log(raw.home)+elo,Math.log(raw.draw)-Math.abs(elo)*.25,Math.log(raw.away)-elo];
  const max=Math.max(...scores),exp=scores.map(x=>Math.exp(x-max)),sum=exp.reduce((a,b)=>a+b,0);
  return temperature({home:exp[0]/sum,draw:exp[1]/sum,away:exp[2]/sum});
}
