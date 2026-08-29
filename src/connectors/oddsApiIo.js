import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { similarity } from "../engine/utils.js";

const BASE="https://api.odds-api.io/v3";
const SLUGS={PL:"england-premier-league",PD:"spain-laliga",BL1:"germany-bundesliga",SA:"italy-serie-a",FL1:"france-ligue-1",CL:"uefa-champions-league",EL:"uefa-europa-league",CLI:"international-clubs-conmebol-libertadores-knockout-stage"};

function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({fetchedAt:Date.now(),data}),"utf8");}
function fileFor(cacheDir,key){return path.join(cacheDir,`${crypto.createHash("sha256").update(key).digest("hex")}.json`);}
async function cachedJson(url,cacheDir,ttlMs,request){
  const file=fileFor(cacheDir,url.pathname+url.search),cached=read(file);
  if(cached&&Date.now()-cached.fetchedAt<=ttlMs)return {data:cached.data,cacheHit:true};
  const response=await request(url);
  if(!response.ok){const detail=String(await response.text()).replace(/apiKey=[^&\s]+/gi,"apiKey=[redacted]").slice(0,240);const error=new Error(`odds-api.io ${response.status}${detail?`: ${detail}`:""}`);error.httpRequests=1;throw error;}
  const data=await response.json();write(file,data);return {data,cacheHit:false};
}
function rows(value){return Array.isArray(value)?value:Array.isArray(value?.data)?value.data:Array.isArray(value?.events)?value.events:[];}
function eventTeams(event){return {home:event.home||event.home_team||event.homeTeam?.name||"",away:event.away||event.away_team||event.awayTeam?.name||""};}
function eventDate(event){return event.date||event.commence_time||event.start_time||event.startAt||null;}
function match(fixture,events){
  return (events||[]).map(event=>{
    const teams=eventTeams(event),home=similarity(fixture.home,teams.home),away=similarity(fixture.away,teams.away);
    const delta=Math.abs(new Date(fixture.utcDate)-new Date(eventDate(event)))/60_000;
    const time=Number.isFinite(delta)&&delta<=180?1-delta/180:0;
    return {event,score:home*.4+away*.4+time*.2,home,away,time};
  }).filter(x=>x.home>=.62&&x.away>=.62&&x.time>0).sort((a,b)=>b.score-a.score)[0]||null;
}
function marketKey(name=""){const n=String(name).toLowerCase();if(["ml","moneyline","moneyline_3way","match winner","1x2","h2h"].includes(n))return"h2h";if(n.includes("handicap")||n==="spread")return"spreads";if(n.includes("total")||n.includes("over/under"))return"totals";return null;}
function normalizeMarket(raw,home,away){
  const key=marketKey(raw.key||raw.name||raw.market||raw.market_type);if(!key)return null;
  const outcomes=[];
  for(const row of raw.outcomes||raw.odds||[]){
    if(Number.isFinite(Number(row.home)))outcomes.push({name:home,price:Number(row.home),point:row.line});
    if(Number.isFinite(Number(row.draw)))outcomes.push({name:"Draw",price:Number(row.draw),point:row.line});
    if(Number.isFinite(Number(row.away)))outcomes.push({name:away,price:Number(row.away),point:row.line});
    if(Number.isFinite(Number(row.over)))outcomes.push({name:"Over",price:Number(row.over),point:row.line});
    if(Number.isFinite(Number(row.under)))outcomes.push({name:"Under",price:Number(row.under),point:row.line});
    const price=Number(row.price??row.odds_decimal??row.decimal??row.odd),label=String(row.name||row.selection||row.side||"");
    if(label&&Number.isFinite(price)){
      const name=/^(draw|x)$/i.test(label)?"Draw":/^(home|1)$/i.test(label)?home:/^(away|2)$/i.test(label)?away:label;
      outcomes.push({name,price,point:row.point??row.line});
    }
  }
  return outcomes.length?{key,outcomes}:null;
}
function normalizeOdds(row,event,matchConfidence=null){
  const teams=eventTeams(event);
  const entries=Array.isArray(row.bookmakers)?row.bookmakers.map(b=>[b.title||b.name,b.markets||b.bets||[]]):Object.entries(row.bookmakers||{});
  const bookmakers=entries.map(([title,markets])=>({title,markets:(markets||[]).map(m=>normalizeMarket(m,teams.home,teams.away)).filter(Boolean)})).filter(b=>b.title&&b.markets.length);
  return {id:String(event.id||event.eventId||""),home_team:teams.home,away_team:teams.away,commence_time:eventDate(event),bookmakers,matchConfidence};
}

export async function getOddsApiIoMarkets({apiKey,bookmakers,fixtures,cacheDir,cacheMinutes=15,request=fetch}){
  if(!apiKey)return {status:"NOT_CONFIGURED",byFixtureId:{},perFixture:{},errors:[],requests:0,cacheHits:0};
  const perFixture=Object.fromEntries(fixtures.map(f=>[f.id,{mapped:Boolean(SLUGS[f.competitionCode]),discovery:"PENDING",events:0,eventMatched:false,oddsReturned:false,bookmakers:0,reason:"PENDING"}]));
  const supported=fixtures;
  const groups=new Map();
  for(const f of supported){const date=String(f.utcDate).slice(0,10),slug=SLUGS[f.competitionCode]||null,key=`${slug||"PUBLIC"}|${date}`;if(!groups.has(key))groups.set(key,{slug,date,fixtures:[]});groups.get(key).fixtures.push(f);}
  const matches=[],errors=[];let requests=0,cacheHits=0;
  for(const group of groups.values()){
    try{
      const times=group.fixtures.map(f=>new Date(f.utcDate).getTime()).filter(Number.isFinite);
      const from=new Date(Math.min(...times)-180*60_000).toISOString(),to=new Date(Math.max(...times)+180*60_000).toISOString();
      const url=new URL(`${BASE}/events`);url.searchParams.set("apiKey",apiKey);url.searchParams.set("sport","football");if(group.slug)url.searchParams.set("league",group.slug);url.searchParams.set("status","pending");url.searchParams.set("from",from);url.searchParams.set("to",to);
      let result;
      try{result=await cachedJson(url,cacheDir,cacheMinutes*60_000,request);}
      catch(error){
        if(!group.slug||!/404.*League not found/i.test(error.message))throw error;
        requests+=Number(error.httpRequests||0);
        url.searchParams.delete("league");
        result=await cachedJson(url,cacheDir,cacheMinutes*60_000,request);
      }
      if(result.cacheHit)cacheHits++;else requests++;
      const events=rows(result.data);
      for(const fixture of group.fixtures){
        const diagnostic=perFixture[fixture.id];diagnostic.discovery=group.slug?"LEAGUE":"PUBLIC";diagnostic.events=events.length;
        const found=match(fixture,events);
        if(found&&found.score>=.7){diagnostic.eventMatched=true;diagnostic.matchConfidence=Number(found.score.toFixed(3));diagnostic.reason="ODDS_PENDING";matches.push({fixture,event:found.event,matchConfidence:diagnostic.matchConfidence});}
        else diagnostic.reason="EVENT_NOT_FOUND";
      }
    }catch(error){
      requests+=Number(error.httpRequests||0);
      errors.push(`${group.slug||"public-football"}: ${error.message}`);
      for(const fixture of group.fixtures)Object.assign(perFixture[fixture.id],{discovery:"ERROR",reason:"DISCOVERY_ERROR",error:error.message});
    }
  }
  const ids=[...new Set(matches.map(x=>String(x.event.id||x.event.eventId||"")).filter(Boolean))];
  const odds=[];
  for(let i=0;i<ids.length;i+=10){
    const part=ids.slice(i,i+10);
    try{
      const url=new URL(`${BASE}/odds/multi`);url.searchParams.set("apiKey",apiKey);url.searchParams.set("eventIds",part.join(","));if(bookmakers)url.searchParams.set("bookmakers",bookmakers);
      const result=await cachedJson(url,cacheDir,cacheMinutes*60_000,request);if(result.cacheHit)cacheHits++;else requests++;odds.push(...rows(result.data));
    }catch(error){requests+=Number(error.httpRequests||0);errors.push(`odds/multi: ${error.message}`);}
  }
  const byExternal=new Map(odds.map(row=>[String(row.id||row.eventId||row.event_id||""),row])),byFixtureId={};
  for(const item of matches){
    const id=String(item.event.id||item.event.eventId||""),row=byExternal.get(id),diagnostic=perFixture[item.fixture.id];
    if(!row){diagnostic.reason="ODDS_NOT_RETURNED";continue;}
    diagnostic.oddsReturned=true;
    const normalized=normalizeOdds(row,item.event,item.matchConfidence);diagnostic.bookmakers=normalized.bookmakers.length;
    if(normalized.bookmakers.length){byFixtureId[item.fixture.id]=normalized;diagnostic.reason="QUOTE_FOUND";}
    else diagnostic.reason="NO_NORMALIZED_BOOKMAKERS";
  }
  return {status:Object.keys(byFixtureId).length?errors.length?"PARTIAL":"OK":errors.length?"ERROR":"NO_ODDS",byFixtureId,perFixture,errors,requests,cacheHits,supported:supported.length,mappedSupported:fixtures.filter(f=>SLUGS[f.competitionCode]).length,matched:Object.keys(byFixtureId).length};
}
