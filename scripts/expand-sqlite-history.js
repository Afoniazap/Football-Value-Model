import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backfillFromProviderCaches } from "../src/history/cacheBackfill.js";
import { appendLocalHistory } from "../src/history/localHistory.js";
import { databaseStats, getTeamLastMatches, importHistoryMatches, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { configureTheSportsDb, getFreeLeagueRoundEvents, getFreeTeamPreviousEvents, getTheSportsDbTelemetry, resetTheSportsDbTelemetry } from "../src/connectors/theSportsDb.js";
import { sameTeamIdentity } from "../src/history/teamAliases.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dataDir=path.join(root,"data");
const historyFile=path.join(dataDir,"history","fixtures.jsonl");
const databaseFile=path.join(dataDir,"history","football.sqlite");
const state=JSON.parse(fs.readFileSync(path.join(dataDir,"state.json"),"utf8"));
const database=openHistoryDatabase(databaseFile);
const minimum=Number(process.env.LOCAL_HISTORY_MIN_MATCHES||4);
const target=Number(process.env.HISTORY_BACKFILL_TARGET||10);

function append(matches,source){
  return appendLocalHistory(historyFile,matches,source,new Date().toISOString(),rows=>importHistoryMatches(database,rows));
}

function fixtureTeams(){
  const teams=new Map();
  for(const fixture of state.results||[]){
    for(const side of ["home","away"]){
      const name=fixture[side];
      const key=name.toLocaleLowerCase("en-US");
      if(!teams.has(key))teams.set(key,{name,kickoffs:[]});
      teams.get(key).kickoffs.push(fixture.utcDate);
    }
  }
  return [...teams.values()].map(team=>({...team,before:team.kickoffs.sort()[0]}));
}

function count(team){return getTeamLastMatches(database,team.name,team.before,20).length;}
const eligible=match=>!/friendl/i.test(String(match.competition?.name||""));

const before=databaseStats(database,databaseFile);
const cache=backfillFromProviderCaches({dataDir,historyFile});
if(cache.added){
  const rows=fs.readFileSync(historyFile,"utf8").trim().split(/\r?\n/).filter(Boolean).slice(-cache.added).map(line=>JSON.parse(line));
  importHistoryMatches(database,rows);
}

configureTheSportsDb({cacheDir:path.join(dataDir,"thesportsdb-cache")});
resetTheSportsDbTelemetry();
const report=[];
const groups=new Map();
function previousSeason(value){
  const range=String(value||"").match(/^(\d{4})-(\d{4})$/);
  if(range)return `${Number(range[1])-1}-${Number(range[2])-1}`;
  return /^\d{4}$/.test(String(value||""))?String(Number(value)-1):null;
}
for(const team of fixtureTeams()){
  const initial=count(team);
  if(initial>=target){report.push({team:team.name,before:initial,after:initial,status:"LOCAL_OK",added:0});continue;}
  try{
    const result=await getFreeTeamPreviousEvents(team.name);
    const temporal=result.matches.filter(match=>eligible(match)&&new Date(match.utcDate)<new Date(team.before));
    const added=append(temporal,"THESPORTSDB");
    report.push({team:team.name,before:initial,after:count(team),status:result.status,providerTeamId:result.team?.id||null,added});
    const reference=temporal[0]||result.matches[0];
    const leagueId=reference?.competition?.id||result.team?.leagueId;
    const league=reference?.competition?.name||result.team?.league;
    const season=previousSeason(reference?.season||result.currentSeason);
    if(count(team)<minimum&&leagueId&&season){
      const key=`${leagueId}|${season}`;
      if(!groups.has(key))groups.set(key,{leagueId,league,season,teams:[]});
      groups.get(key).teams.push(team);
    }
  }catch(error){
    report.push({team:team.name,before:initial,after:count(team),status:"ERROR",reason:error.message,added:0});
  }
}

const leagueBackfill=[];
for(const group of groups.values()){
  if(/friendl/i.test(String(group.league||""))){leagueBackfill.push({league:group.league,season:group.season,rounds:0,returned:0,targetMatches:0,added:0,status:"UNSUPPORTED"});continue;}
  let returned=0,added=0,targetMatches=0,selectedSeason=group.season;
  const candidates=[group.season];
  if(/^\d{4}$/.test(group.season))candidates.push(`${group.season}-${Number(group.season)+1}`);
  else if(/^\d{4}-\d{4}$/.test(group.season))candidates.push(group.season.slice(0,4));
  for(const season of candidates){
    const seasonMatches=[];
    for(let round=1;round<=6;round++)seasonMatches.push(...await getFreeLeagueRoundEvents(group.leagueId,season,round));
    const cutoff=Math.max(...group.teams.map(team=>new Date(team.before).getTime()));
    const temporal=seasonMatches.filter(match=>eligible(match)&&new Date(match.utcDate).getTime()<cutoff);
    const relevant=temporal.filter(match=>group.teams.some(team=>sameTeamIdentity(match.homeTeam?.name,team.name)||sameTeamIdentity(match.awayTeam?.name,team.name)));
    returned+=temporal.length;targetMatches+=relevant.length;selectedSeason=season;
    if(relevant.length){added+=append(temporal,"THESPORTSDB");break;}
  }
  leagueBackfill.push({league:group.league,season:selectedSeason,rounds:6,returned,targetMatches,added});
}

const after=databaseStats(database,databaseFile);
const fixtures=(state.results||[]).map(fixture=>{
  const home=getTeamLastMatches(database,fixture.home,fixture.utcDate,20).length;
  const away=getTeamLastMatches(database,fixture.away,fixture.utcDate,20).length;
  return {fixture:`${fixture.home} - ${fixture.away}`,home,away,ready:home>=minimum&&away>=minimum};
});
const teamIndex=new Map(fixtureTeams().map(team=>[team.name,team]));
console.log(JSON.stringify({before,after,cache,theSportsDb:getTheSportsDbTelemetry(),leagueBackfill,teams:report.map(row=>({...row,after:count(teamIndex.get(row.team))})),coverage:{fixtures:fixtures.length,ready:fixtures.filter(row=>row.ready).length,blocked:fixtures.filter(row=>!row.ready)}},null,2));
