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
  getFixtureRisk
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
  assert.deepEqual(getApiFootballTelemetry(30),{requests:1,cacheHits:0,staleHits:0,avoided:1,deduplicated:0,dailyLimit:true,estimatedDailyRequests:48});
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

test("lineups are avoided until the fixture is close enough",async()=>{
  let now=2_000_000;
  const paths=[];
  configureApiFootball({cacheDir:tempDir(),minGapMs:0,now:()=>now,fetchImpl:async url=>{paths.push(new URL(url).pathname);return response(validEmpty);}});
  beginApiFootballRefresh();
  await getFixtureRisk("secret",123,new Date(now+3*3600_000).toISOString());
  assert.deepEqual(paths,["/injuries"]);
  assert.equal(getApiFootballTelemetry().avoided,1);
});
