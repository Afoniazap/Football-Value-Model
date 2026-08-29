import fs from "node:fs";
import path from "node:path";
import { canonicalTeamName } from "../history/teamAliases.js";

function read(filePath){try{return JSON.parse(fs.readFileSync(filePath,"utf8"));}catch{return {version:1,snapshots:{}};}}
function write(filePath,value){fs.mkdirSync(path.dirname(filePath),{recursive:true});fs.writeFileSync(filePath,JSON.stringify(value),"utf8");}
function key(fixture){return `${String(fixture.utcDate).slice(0,16)}|${canonicalTeamName(fixture.home)}|${canonicalTeamName(fixture.away)}`;}
function validMarket(data){return Boolean(data&&Array.isArray(data.bookmakers)&&data.bookmakers.length&&data.best);}

function resolveOne(store,{fixture,freshMarket,now,freshMs,staleMs}){
  const snapshotKey=key(fixture);
  if(validMarket(freshMarket)){
    const fetchedAt=new Date(now).toISOString();
    store.snapshots[snapshotKey]={fixtureId:String(fixture.id),home:fixture.home,away:fixture.away,kickoff:fixture.utcDate,provider:freshMarket.source||"UNKNOWN",fetchedAt,data:freshMarket};
    return {marketData:{...freshMarket,marketFreshness:"FRESH",marketFetchedAt:fetchedAt},freshness:"FRESH",fetchedAt,changed:true};
  }
  const snapshot=store.snapshots[snapshotKey];
  if(!snapshot)return {marketData:null,freshness:"MISSING",fetchedAt:null};
  const age=now-new Date(snapshot.fetchedAt).getTime();
  const freshness=age<=freshMs?"FRESH":age<=staleMs?"STALE":"EXPIRED";
  if(freshness==="EXPIRED")return {marketData:null,freshness,fetchedAt:snapshot.fetchedAt,provider:snapshot.provider};
  return {marketData:{...snapshot.data,source:snapshot.provider,marketFreshness:freshness,marketFetchedAt:snapshot.fetchedAt},freshness,fetchedAt:snapshot.fetchedAt,provider:snapshot.provider};
}

export function resolveMarketSnapshots({filePath,entries,now=Date.now(),freshMs=15*60_000,staleMs=6*3600_000}){
  const store=read(filePath),results=new Map();
  let changed=false;
  for(const entry of entries){
    const result=resolveOne(store,{...entry,now,freshMs,staleMs});
    changed=changed||Boolean(result.changed);
    delete result.changed;
    results.set(entry.fixture.id,result);
  }
  if(changed)write(filePath,store);
  return results;
}

export function resolveMarketSnapshot(options){
  return resolveMarketSnapshots({...options,entries:[{fixture:options.fixture,freshMarket:options.freshMarket}]}).get(options.fixture.id);
}

export function enforceMarketFreshness(result,freshness){
  const next={...result,marketFreshness:freshness};
  if(freshness==="STALE"&&next.category==="VALUE")return {...next,category:"WAIT",reason:"Рынок STALE: новый VALUE запрещён до получения свежей котировки."};
  return next;
}
