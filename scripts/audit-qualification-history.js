import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalHistory } from "../src/history/localHistory.js";
import { sameTeamIdentity, teamIdentityEvidence } from "../src/history/teamAliases.js";
import { similarity } from "../src/engine/utils.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dataDir=path.join(root,"data");
const state=JSON.parse(fs.readFileSync(path.join(dataDir,"state.json"),"utf8"));
const fixtures=(state.results||[]).filter(row=>row.apiFootballLeagueId===3);
const history=loadLocalHistory(path.join(dataDir,"history","fixtures.jsonl"),path.join(dataDir,"history.json"));
const targets=[...new Map(fixtures.flatMap(fixture=>[
  [String(fixture.homeId),{id:fixture.homeId,name:fixture.home,kickoff:fixture.utcDate}],
  [String(fixture.awayId),{id:fixture.awayId,name:fixture.away,kickoff:fixture.utcDate}]
])).values()];
const summaryOnly=process.argv.includes("--summary");

function sideMatches(row,target,side){
  const team=row[side];
  if(row.provenance?.source==="API_FOOTBALL"&&target.id!=null&&String(team?.id)===String(target.id))return true;
  const evidence=teamIdentityEvidence(target.name);
  if(row.provenance?.source==="THESPORTSDB"&&evidence?.source==="THESPORTSDB"&&team?.id!=null&&String(team.id)!==String(evidence.teamId))return false;
  return sameTeamIdentity(team?.name,target.name);
}

const identities=new Map();
for(const row of history){
  for(const side of ["homeTeam","awayTeam"]){
    const team=row[side];
    if(!team?.name)continue;
    const key=`${team.name}|${team.id??""}`;
    const item=identities.get(key)||{name:team.name,id:team.id??null,records:0,provenance:new Set()};
    item.records++;
    for(const source of row.provenance?.sources||[row.provenance?.source])if(source)item.provenance.add(source);
    identities.set(key,item);
  }
}

const teams=targets.map(target=>{
  const candidateIdentities=[...identities.values()].map(item=>({...item,score:similarity(target.name,item.name)})).filter(item=>item.score>=.45);
  const candidateNames=new Set(candidateIdentities.map(item=>item.name));
  const candidates=history.filter(row=>candidateNames.has(row.homeTeam?.name)||candidateNames.has(row.awayTeam?.name));
  const confirmed=history.filter(row=>sideMatches(row,target,"homeTeam")||sideMatches(row,target,"awayTeam"));
  const temporalSafe=confirmed.filter(row=>Number.isFinite(new Date(row.playedAt).getTime())&&new Date(row.playedAt)<new Date(target.kickoff));
  return {
    ...target,
    totalCandidateRecords:candidates.length,
    identityConfirmedRecords:confirmed.length,
    temporalSafeFinishedMatches:temporalSafe.length,
    provenance:[...new Set(temporalSafe.flatMap(row=>row.provenance?.sources||[row.provenance?.source]).filter(Boolean))],
    usableCount:Math.min(20,temporalSafe.length),
    ...(summaryOnly?{}:{candidateIdentities:candidateIdentities.sort((a,b)=>b.score-a.score||b.records-a.records).slice(0,8).map(item=>({name:item.name,id:item.id,records:item.records,score:Number(item.score.toFixed(3)),provenance:[...item.provenance]}))})
  };
});

const fixtureContexts=fixtures.map(fixture=>{
  const home=teams.find(team=>String(team.id)===String(fixture.homeId));
  const away=teams.find(team=>String(team.id)===String(fixture.awayId));
  const ready=home.usableCount>=4&&away.usableCount>=4;
  return {fixture:`${fixture.home} - ${fixture.away}`,homeHistory:home.usableCount,awayHistory:away.usableCount,status:ready?"READY":"BLOCKED",reason:ready?null:`MIN_HISTORY: home ${home.usableCount}/4, away ${away.usableCount}/4`};
});

console.log(JSON.stringify({
  totalHistory:history.length,
  teams,
  summary:{ge3:teams.filter(x=>x.usableCount>=3).length,ge5:teams.filter(x=>x.usableCount>=5).length,ge10:teams.filter(x=>x.usableCount>=10).length,ge15:teams.filter(x=>x.usableCount>=15).length},
  fixtureContexts
},null,2));
