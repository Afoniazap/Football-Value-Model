import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureFootballData, getCompetitionContext, getFinishedFootballDataMatchesForDate } from "../src/connectors/footballData.js";

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
