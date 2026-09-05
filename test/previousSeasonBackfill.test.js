import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openHistoryDatabase, importHistoryMatches } from "../src/history/sqliteHistory.js";
import { ensurePreviousSeasonHistory } from "../src/history/previousSeasonBackfill.js";

function tempDb(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-backfill-")),"football.sqlite");}
function match(id,season,playedAt="2024-09-01T18:00:00Z"){
  return {recordKey:`FOOTBALL_DATA:${id}`,sourceFixtureId:id,playedAt,status:"FINISHED",sport:"FOOTBALL",
    competition:{code:"PL",name:"PL",season},homeTeam:{id:"1",name:"Alpha"},awayTeam:{id:"2",name:"Beta"},
    score:{fullTime:{home:1,away:0}},provenance:{source:"FOOTBALL_DATA"},fetchedAt:playedAt};
}

test("previous season is fetched at most once per competition — cache-first against local SQLite",async()=>{
  const db=openHistoryDatabase(tempDb());
  let fetchCalls=0;
  const deps={
    fetchSeason:async(code,season)=>{fetchCalls++;return [{id:"remote-1",playedAt:"2024-09-02T18:00:00Z",status:"FINISHED",competition:{code,season},homeTeam:{id:1,name:"Alpha"},awayTeam:{id:2,name:"Beta"},score:{fullTime:{home:2,away:1}}}];},
    importMatches:matches=>importHistoryMatches(db,matches.map(m=>({...m,provenance:{source:"FOOTBALL_DATA"}}))).inserted
  };
  const first=await ensurePreviousSeasonHistory(db,"PL","2025",deps);
  assert.equal(first.fetched,true);
  assert.equal(fetchCalls,1);

  const second=await ensurePreviousSeasonHistory(db,"PL","2025",deps);
  assert.equal(second.fetched,false);
  assert.equal(second.reason,"ALREADY_PRESENT");
  assert.equal(fetchCalls,1,"a competition that already has previous-season rows must not be re-fetched");
  db.close();
});

test("already-imported previous season (e.g. from the manual bootstrap script) is reused without any network call",async()=>{
  const db=openHistoryDatabase(tempDb());
  importHistoryMatches(db,[match("manual-1","2025")]);
  let fetchCalls=0;
  const result=await ensurePreviousSeasonHistory(db,"PL","2026",{fetchSeason:async()=>{fetchCalls++;return [];},importMatches:()=>0});
  assert.equal(result.fetched,false);
  assert.equal(result.reason,"ALREADY_PRESENT");
  assert.equal(fetchCalls,0);
  db.close();
});

test("missing competition code or non-numeric season is a safe no-op, not an error",async()=>{
  const db=openHistoryDatabase(tempDb());
  const deps={fetchSeason:async()=>{throw new Error("must not be called");},importMatches:()=>0};
  assert.equal((await ensurePreviousSeasonHistory(db,null,"2025",deps)).reason,"MISSING_INPUT");
  assert.equal((await ensurePreviousSeasonHistory(db,"PL",undefined,deps)).reason,"MISSING_INPUT");
  db.close();
});

test("a provider failure for one competition is reported, not thrown, so other competitions keep going",async()=>{
  const db=openHistoryDatabase(tempDb());
  const result=await ensurePreviousSeasonHistory(db,"PL","2025",{fetchSeason:async()=>{throw new Error("football-data 429: rate limited");},importMatches:()=>0});
  assert.equal(result.fetched,false);
  assert.match(result.reason,/rate limited/);
  db.close();
});
