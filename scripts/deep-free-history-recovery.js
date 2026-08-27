import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backfillFromProviderCaches } from "../src/history/cacheBackfill.js";
import { appendLocalHistory, buildLocalHistoryContext, loadLocalHistory } from "../src/history/localHistory.js";
import { configureFootballData, getFinishedCompetitionSeason } from "../src/connectors/footballData.js";
import { configureTheSportsDb, getFreeLeagueRoundEvents, getFreeTeamPreviousEvents, getTheSportsDbTelemetry, resetTheSportsDbTelemetry } from "../src/connectors/theSportsDb.js";
import { sameTeamIdentity, teamIdentityEvidence } from "../src/history/teamAliases.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dataDir=path.join(root,"data");
const historyFile=path.join(dataDir,"history","fixtures.jsonl");
const legacyFile=path.join(dataDir,"history.json");
const state=JSON.parse(fs.readFileSync(path.join(dataDir,"state.json"),"utf8"));
const fixtures=(state.results||[]).filter(row=>row.apiFootballLeagueId===3);
const targets=[...new Map(fixtures.flatMap(row=>[[String(row.homeId),{id:row.homeId,name:row.home,kickoff:row.utcDate}],[String(row.awayId),{id:row.awayId,name:row.away,kickoff:row.utcDate}]])).values()];

configureFootballData({cacheDir:path.join(dataDir,"football-data-cache")});
configureTheSportsDb({cacheDir:path.join(dataDir,"thesportsdb-cache")});
resetTheSportsDbTelemetry();

const report={local:backfillFromProviderCaches({dataDir,historyFile}),footballData:[],theSportsDb:{teams:[],groups:[]}};
for(const code of ["CL","PPL"]){
  try{
    const matches=await getFinishedCompetitionSeason(process.env.FOOTBALL_DATA_TOKEN?.trim(),code,2025);
    const added=appendLocalHistory(historyFile,matches,"FOOTBALL_DATA");
    report.footballData.push({code,season:2025,returned:matches.length,added,status:"OK"});
  }catch(error){report.footballData.push({code,season:2025,returned:0,added:0,status:"ERROR",reason:error.message});}
}

function previousSeason(value){
  const range=String(value||"").match(/^(\d{4})-(\d{4})$/);
  if(range)return `${Number(range[1])-1}-${Number(range[2])-1}`;
  const year=String(value||"").match(/^\d{4}$/);
  return year?String(Number(year[0])-1):null;
}

const groups=new Map();
for(const target of targets){
  try{
    const result=await getFreeTeamPreviousEvents(target.name);
    const added=appendLocalHistory(historyFile,result.matches,"THESPORTSDB");
    const season=previousSeason(result.currentSeason);
    report.theSportsDb.teams.push({...target,status:result.status,providerTeamId:result.team?.id||null,leagueId:result.team?.leagueId||null,currentSeason:result.currentSeason,previousSeason:season,returned:result.matches.length,added});
    if(result.status==="OK"&&result.team?.leagueId&&season){
      const key=`${result.team.leagueId}|${season}`;
      if(!groups.has(key))groups.set(key,{leagueId:result.team.leagueId,league:result.team.league,season,targets:[]});
      groups.get(key).targets.push(target.name);
    }
    for(const historical of teamIdentityEvidence(target.name)?.historicalLeagues||[]){
      const key=`${historical.id}|${historical.season}`;
      if(!groups.has(key))groups.set(key,{leagueId:historical.id,league:historical.name,season:historical.season,targets:[]});
      groups.get(key).targets.push(target.name);
    }
  }catch(error){report.theSportsDb.teams.push({...target,status:"ERROR",reason:error.message,returned:0,added:0});}
}

for(const group of groups.values()){
  let returned=0,added=0,status="OK",reason=null,targetMatches=0,selectedSeason=group.season;
  const seasons=[group.season];
  if(String(group.season).includes("-"))seasons.push(String(group.season).split("-")[0]);
  else if(/^\d{4}$/.test(String(group.season)))seasons.push(`${group.season}-${Number(group.season)+1}`);
  for(const season of seasons){
    let seasonReturned=0,seasonTargetMatches=0;
    for(let round=1;round<=6;round++){
      try{
        const matches=await getFreeLeagueRoundEvents(group.leagueId,season,round);
        seasonReturned+=matches.length;
        seasonTargetMatches+=matches.filter(match=>group.targets.some(name=>sameTeamIdentity(match.homeTeam?.name,name)||sameTeamIdentity(match.awayTeam?.name,name))).length;
        added+=appendLocalHistory(historyFile,matches,"THESPORTSDB");
      }catch(error){status="PARTIAL";reason=error.message;break;}
    }
    returned+=seasonReturned;targetMatches+=seasonTargetMatches;selectedSeason=season;
    if(seasonTargetMatches>0||status==="PARTIAL")break;
  }
  report.theSportsDb.groups.push({...group,selectedSeason,rounds:6,returned,targetMatches,added,status,reason});
  console.error(`TheSportsDB: ${group.league} ${selectedSeason} returned=${returned} target=${targetMatches} added=${added}`);
}

const history=loadLocalHistory(historyFile,legacyFile);
const teams=targets.map(target=>{
  const fixture=fixtures.find(row=>String(row.homeId)===String(target.id)||String(row.awayId)===String(target.id));
  const context=buildLocalHistoryContext(history,fixture);
  const home=String(fixture.homeId)===String(target.id);
  return {...target,usable:home?context.contextMeta.homeMatches:context.contextMeta.awayMatches,provenance:home?context.contextMeta.homeSources:context.contextMeta.awaySources};
});
const fixtureContexts=fixtures.map(fixture=>{
  const context=buildLocalHistoryContext(history,fixture);
  const home=context.contextMeta.homeMatches,away=context.contextMeta.awayMatches,ready=Boolean(context.standings);
  return {fixture:`${fixture.home} - ${fixture.away}`,homeHistory:home,awayHistory:away,status:ready?"READY":"BLOCKED",reason:ready?null:`MIN_HISTORY: home ${home}/4, away ${away}/4`};
});

console.log(JSON.stringify({
  report:{...report,theSportsDb:{...report.theSportsDb,telemetry:getTheSportsDbTelemetry()}},
  totalHistory:history.length,
  teams,
  summary:{ge3:teams.filter(x=>x.usable>=3).length,ge5:teams.filter(x=>x.usable>=5).length,ge10:teams.filter(x=>x.usable>=10).length,ge15:teams.filter(x=>x.usable>=15).length},
  fixtureContexts
},null,2));
