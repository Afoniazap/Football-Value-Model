import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureApiFootball,
  beginApiFootballRefresh,
  getApiFootballTelemetry,
  getFinishedFixturesForDate,
  getFixtureRisk,
  getFixturesRisk,
  getFixturesOdds,
  getUpcomingApiFootballMatches
} from "../src/connectors/apiFootball.js";

function tempDir(){return fs.mkdtempSync(path.join(os.tmpdir(),"fvm-api-football-"));}
function response(payload,status=200){return {ok:status>=200&&status<300,status,json:async()=>payload,text:async()=>JSON.stringify(payload)};}
const validEmpty={get:"fixtures",parameters:{},errors:[],results:0,paging:{current:1,total:1},response:[]};

test("HTTP 200 with errors.requests is a daily-limit failure, not an empty result",async()=>{
  let calls=0;
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl:async()=>{calls++;return response({...validEmpty,errors:{requests:"You have reached the request limit for the day"}});}});
  beginApiFootballRefresh();
  await assert.rejects(getFinishedFixturesForDate("secret","2026-08-23"),e=>e.code==="DAILY_LIMIT"&&e.message==="API-Football: DAILY LIMIT");
  await assert.rejects(getFinishedFixturesForDate("secret","2026-08-22"),e=>e.code==="DAILY_LIMIT");
  assert.equal(calls,1);
  assert.deepEqual(getApiFootballTelemetry(30),{requests:1,requestsByEndpoint:{"/fixtures":1},cacheHits:0,staleHits:0,avoided:1,deduplicated:0,dailyLimit:true,estimatedDailyRequests:48});
});

test("HTTP 200 with errors.rateLimit daily message also activates daily backoff",async()=>{
  let calls=0;
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl:async()=>{calls++;return response({...validEmpty,errors:{rateLimit:"Too many requests. You have reached your daily request limit."}});}});
  beginApiFootballRefresh();
  await assert.rejects(getFinishedFixturesForDate("secret","2026-08-23"),e=>e.code==="DAILY_LIMIT");
  await assert.rejects(getFinishedFixturesForDate("secret","2026-08-22"),e=>e.code==="DAILY_LIMIT");
  assert.equal(calls,1);
});

test("HTTP 429 with errors.rateLimit daily message activates backoff without retry",async()=>{
  let calls=0;
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl:async()=>{calls++;return response({...validEmpty,errors:{rateLimit:"Too many requests. You have reached your daily request limit."}},429);}});
  beginApiFootballRefresh();
  await assert.rejects(getFinishedFixturesForDate("secret","2026-08-23"),e=>e.code==="DAILY_LIMIT"&&e.message==="API-Football: DAILY LIMIT");
  await assert.rejects(getFinishedFixturesForDate("secret","2026-08-22"),e=>e.code==="DAILY_LIMIT");
  assert.equal(calls,1);
  assert.equal(getApiFootballTelemetry().dailyLimit,true);
  assert.equal(getApiFootballTelemetry().avoided,1);
});

test("genuine empty fixture response remains a valid empty list and is cached",async()=>{
  let calls=0;
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl:async()=>{calls++;return response(validEmpty);}});
  beginApiFootballRefresh();
  assert.deepEqual(await getFinishedFixturesForDate("secret","2026-08-23"),[]);
  assert.deepEqual(await getFinishedFixturesForDate("secret","2026-08-23"),[]);
  assert.equal(calls,1);
  assert.equal(getApiFootballTelemetry().cacheHits,1);
});

test("concurrent identical requests share one network call",async()=>{
  let calls=0,release;
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl:async()=>{calls++;await new Promise(r=>{release=r;});return response(validEmpty);}});
  beginApiFootballRefresh();
  const first=getFinishedFixturesForDate("secret","2026-08-23");
  const second=getFinishedFixturesForDate("secret","2026-08-23");
  await new Promise(r=>setImmediate(r));release();
  await Promise.all([first,second]);
  assert.equal(calls,1);
  assert.equal(getApiFootballTelemetry().deduplicated,1);
});

test("daily-limit response uses a safe stale finished-fixture cache",async()=>{
  let now=1_000_000,calls=0,limited=false;
  const cacheDir=tempDir();
  const finished={...validEmpty,results:1,response:[{fixture:{id:7,date:"2026-08-23T18:00:00Z",status:{short:"FT"}},league:{id:61,name:"Ligue 1",country:"France",season:2026},teams:{home:{id:1,name:"A"},away:{id:2,name:"B"}},goals:{home:1,away:0}}]};
  configureApiFootball({cacheDir,minGapMs:0,now:()=>now,fetchImpl:async()=>{calls++;return response(limited?{...validEmpty,errors:{requests:"request limit for the day"}}:finished);}});
  assert.equal((await getFinishedFixturesForDate("secret","2026-08-23")).length,1);
  now+=25*3600_000;limited=true;beginApiFootballRefresh();
  assert.equal((await getFinishedFixturesForDate("secret","2026-08-23")).length,1);
  assert.equal(calls,2);
  assert.equal(getApiFootballTelemetry().staleHits,1);
  assert.equal(getApiFootballTelemetry().dailyLimit,true);
});

test("daily limit keeps a stale upcoming-fixture date cache and does not discard a partial date",async()=>{
  let now=Date.parse("2026-08-27T12:00:00Z"),limited=false,calls=0;
  const fixture={...validEmpty,results:1,response:[{fixture:{id:7,date:"2026-08-27T18:00:00Z",status:{short:"NS"}},league:{id:3,name:"UEFA Europa League",country:"World",season:2026,round:"Play-offs"},teams:{home:{id:1,name:"A"},away:{id:2,name:"B"}}}]};
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,now:()=>now,fetchImpl:async url=>{calls++;const date=new URL(url).searchParams.get("date");return response(limited?{...validEmpty,errors:{requests:"request limit for the day"}}:date==="2026-08-27"?fixture:validEmpty);}});
  assert.equal((await getUpcomingApiFootballMatches("secret",24)).length,1);
  now+=3*3600_000;limited=true;beginApiFootballRefresh();
  const cached=await getUpcomingApiFootballMatches("secret",24);
  assert.equal(cached.length,1);
  assert.equal(cached[0].id,"7");
  assert.equal(getApiFootballTelemetry().dailyLimit,true);
  assert.ok(getApiFootballTelemetry().staleHits>=1);
});

test("lineups are avoided until the fixture is close enough",async()=>{
  let now=2_000_000;
  const paths=[];
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,now:()=>now,fetchImpl:async url=>{paths.push(new URL(url).pathname);return response(validEmpty);}});
  beginApiFootballRefresh();
  await getFixtureRisk("secret",123,new Date(now+3*3600_000).toISOString());
  assert.deepEqual(paths,["/injuries"]);
  assert.equal(getApiFootballTelemetry().avoided,1);
});

test("56 fixtures use date batches for odds and injuries instead of 112 per-fixture calls",async()=>{
  const now=Date.parse("2026-08-29T08:00:00Z"),urls=[];
  const fixtures=Array.from({length:56},(_,index)=>({
    apiFootballFixtureId:index+1,
    utcDate:index<28?"2026-08-29T18:00:00Z":"2026-08-30T18:00:00Z"
  }));
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,now:()=>now,fetchImpl:async url=>{
    urls.push(url);
    const endpoint=new URL(url).pathname;
    const date=new URL(url).searchParams.get("date");
    const start=date==="2026-08-29"?1:29;
    const rows=Array.from({length:28},(_,offset)=>{
      const id=start+offset;
      if(endpoint==="/injuries")return {fixture:{id},player:{id,name:`P${id}`}};
      return {fixture:{id},bookmakers:[{name:"Book",bets:[{name:"Match Winner",values:[{value:"Home",odd:"2.10"},{value:"Draw",odd:"3.20"},{value:"Away",odd:"3.40"}]}]}]};
    });
    return response({...validEmpty,results:rows.length,response:rows});
  }});
  beginApiFootballRefresh();
  const markets=await getFixturesOdds("secret",fixtures);
  const risks=await getFixturesRisk("secret",fixtures);
  assert.equal(Object.keys(markets).length,56);
  assert.equal(Object.keys(risks).length,56);
  assert.deepEqual(markets["1"].best.h2h.home,{odds:2.1,bookmaker:"Book"});
  assert.equal(getApiFootballTelemetry().requests,4);
  assert.equal(urls.filter(url=>new URL(url).pathname==="/odds").length,2);
  assert.equal(urls.filter(url=>new URL(url).pathname==="/injuries").length,2);
  assert.equal(urls.filter(url=>new URL(url).pathname.includes("lineups")).length,0);
  assert.equal(getApiFootballTelemetry().avoided,56);
});

test("daily limit in a date batch stops later pages/dates without retry storm",async()=>{
  let calls=0;
  const fixtures=[{apiFootballFixtureId:1,utcDate:"2026-08-29T18:00:00Z"},{apiFootballFixtureId:2,utcDate:"2026-08-30T18:00:00Z"}];
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl:async()=>{calls++;return response({...validEmpty,errors:{requests:"You have reached the request limit for the day"}});}});
  beginApiFootballRefresh();
  await assert.rejects(getFixturesOdds("secret",fixtures),error=>error.code==="DAILY_LIMIT");
  assert.equal(calls,1);
  assert.equal(getApiFootballTelemetry().requests,1);
});

test("date-batched odds normalization is identical to the existing fixture endpoint",async()=>{
  const row={fixture:{id:77},bookmakers:[{name:"Parity Book",bets:[
    {name:"Match Winner",values:[{value:"Home",odd:"1.95"},{value:"Draw",odd:"3.50"},{value:"Away",odd:"4.20"}]},
    {name:"Goals Over/Under",values:[{value:"Over 2.5",odd:"1.88"},{value:"Under 2.5",odd:"2.02"}]}
  ]}]};
  const fetchImpl=async()=>response({...validEmpty,results:1,response:[row]});
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl});beginApiFootballRefresh();
  const perFixture=(await import("../src/connectors/apiFootball.js")).getFixtureOdds;
  const oldResult=await perFixture("secret",77);
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl});beginApiFootballRefresh();
  const batchResult=await getFixturesOdds("secret",[{apiFootballFixtureId:77,utcDate:"2026-08-29T18:00:00Z"}]);
  assert.deepEqual(batchResult["77"],oldResult);
});

test("free odds pagination stops at page 3 and falls back only to unresolved fixture IDs",async()=>{
  const urls=[];
  const row={fixture:{id:99},bookmakers:[{name:"Fixture Book",bets:[{name:"Match Winner",values:[{value:"Home",odd:"2.20"},{value:"Draw",odd:"3.10"},{value:"Away",odd:"3.30"}]}]}]};
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,fetchImpl:async url=>{
    urls.push(url);
    const parsed=new URL(url),fixture=parsed.searchParams.get("fixture"),page=parsed.searchParams.get("page");
    if(fixture==="99")return response({...validEmpty,results:1,response:[row]});
    return response({...validEmpty,paging:{current:Number(page||1),total:5}});
  }});
  beginApiFootballRefresh();
  const result=await getFixturesOdds("secret",[{apiFootballFixtureId:99,utcDate:"2026-08-31T18:00:00Z"}]);
  assert.ok(result["99"]);
  assert.equal(urls.some(url=>new URL(url).searchParams.get("page")==="4"),false);
  assert.equal(urls.filter(url=>new URL(url).searchParams.has("fixture")).length,1);
  assert.equal(urls.length,4);
});
