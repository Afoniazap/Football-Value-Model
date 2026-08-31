import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginFootballDataRefresh, configureFootballData, getCompetitionContext, getFinishedCompetitionSeason, getFinishedFootballDataMatchesForDate, getFootballDataTelemetry } from "../src/connectors/footballData.js";

test("Football-Data competition context reuses persistent endpoint cache",async()=>{
  let calls=0;
  configureFootballData({cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-fd-")),fetchImpl:async url=>{calls++;return {ok:true,json:async()=>url.includes("standings")?{standings:[]}:{matches:[]}};}});
  await getCompetitionContext("secret","PD");
  await getCompetitionContext("secret","PD");
  assert.equal(calls,3);
});

test("Football-Data daily harvest использует разрешённый date endpoint и cache",async()=>{
  let calls=0;
  configureFootballData({cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-fd-daily-")),fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({matches:[{id:1,status:"FINISHED"}]})};}});
  assert.equal((await getFinishedFootballDataMatchesForDate("secret","2026-08-26")).length,1);
  assert.equal((await getFinishedFootballDataMatchesForDate("secret","2026-08-26")).length,1);
  assert.equal(calls,1);
});

test("Football-Data season backfill caches official finished competition matches",async()=>{
  let calls=0;
  configureFootballData({cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-fd-season-")),fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({matches:[{id:1,status:"FINISHED"}]})};}});
  assert.equal((await getFinishedCompetitionSeason("token","CL",2025)).length,1);
  assert.equal((await getFinishedCompetitionSeason("token","CL",2025)).length,1);
  assert.equal(calls,1);
});

test("Football-Data 429 включает persistent provider backoff и отдаёт допустимый stale cache без retry storm",async()=>{
  const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),"fvm-fd-429-"));let now=Date.parse("2026-08-31T00:00:00Z"),calls=0,limited=false;
  const fetchImpl=async()=>{calls++;if(limited)return {ok:false,status:429,headers:{get:name=>name==="retry-after"?"120":null},text:async()=>"rate limited"};return {ok:true,status:200,json:async()=>({matches:[{id:7,status:"FINISHED"}]})};};
  configureFootballData({cacheDir,now:()=>now,fetchImpl,rateLimitBackoffMs:60_000});beginFootballDataRefresh();
  assert.equal((await getFinishedFootballDataMatchesForDate("secret","2026-08-30")).length,1);
  now+=25*3600_000;limited=true;
  assert.equal((await getFinishedFootballDataMatchesForDate("secret","2026-08-30")).length,1);
  await getCompetitionContext("secret","PL");
  assert.equal(calls,2);
  assert.deepEqual({...getFootballDataTelemetry(),deduplicated:0},{requests:2,cacheHits:0,staleHits:1,avoided:3,deduplicated:0,rateLimited:true,degraded:true});

  configureFootballData({cacheDir,now:()=>now,fetchImpl});beginFootballDataRefresh();
  await assert.rejects(()=>getFinishedFootballDataMatchesForDate("secret","2026-08-29"),error=>error.code==="RATE_LIMIT");
  assert.equal(calls,2);
});
