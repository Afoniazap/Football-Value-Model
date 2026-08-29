import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureTheSportsDb, exactTeamMatch, getFreeLeagueRoundEvents, getFreeTeamPreviousEvents, getTheSportsDbTelemetry, resetTheSportsDbTelemetry } from "../src/connectors/theSportsDb.js";

function response(data) { return { ok: true, json: async () => data }; }

test("TheSportsDB mapping принимает только одно точное нормализованное имя", () => {
  assert.equal(exactTeamMatch("FC Benfica", [{ idTeam: "134108", strTeam: "Benfica",strSport:"Soccer" }]).idTeam, "134108");
  assert.equal(exactTeamMatch("Aarhus", [{ idTeam: "133899", strTeam: "AGF Aarhus",strSport:"Soccer" }]).idTeam, "133899");
  assert.equal(exactTeamMatch("Aarhus", [{ idTeam: "2", strTeam: "Aarhus Fremad",strSport:"Soccer" }]), null);
  assert.equal(exactTeamMatch("Benfica", [{ idTeam: "1", strTeam: "Benfica",strSport:"Soccer" }, { idTeam: "2", strTeam: "Benfica FC",strSport:"Soccer" }]), null);
  assert.equal(exactTeamMatch("Plzen",[{idTeam:"hockey",strTeam:"Plzen",strSport:"Ice Hockey"}]),null);
});

test("TheSportsDB previous events нормализуются и используют persistent cache", async () => {
  const calls = [];
  configureTheSportsDb({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "fvm-tsdb-")), minGapMs: 0, fetchImpl: async url => {
    calls.push(url);
    return url.includes("searchteams") ? response({ teams: [{ idTeam: "134108", strTeam: "Benfica",strSport:"Soccer",idLeague:"1",strLeague:"League" }] }) : response({ results: [
      { idEvent: "7", strStatus: "FT", dateEvent: "2026-08-20", strTime: "19:00:00", idLeague: "1", strLeague: "League", idHomeTeam: "134108", strHomeTeam: "Benfica", idAwayTeam: "20", strAwayTeam: "B", intHomeScore: "2", intAwayScore: "0" },
      { idEvent: "8", strStatus: "NS", dateEvent: "2026-08-30", strHomeTeam: "Benfica", strAwayTeam: "C" }
    ] });
  }});
  resetTheSportsDbTelemetry();
  assert.equal((await getFreeTeamPreviousEvents("Benfica")).matches.length, 1);
  assert.equal((await getFreeTeamPreviousEvents("Benfica")).matches.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(getTheSportsDbTelemetry().cacheHits, 2);
});

test("TheSportsDB league round accepts finished football only and caches it",async()=>{
  let calls=0;
  configureTheSportsDb({cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-tsdb-round-")),minGapMs:0,fetchImpl:async()=>{calls++;return response({events:[
    {idEvent:"9",strStatus:"FT",dateEvent:"2025-08-01",strSport:"Soccer",idHomeTeam:"1",strHomeTeam:"A",idAwayTeam:"2",strAwayTeam:"B",intHomeScore:"1",intAwayScore:"0"},
    {idEvent:"handball",strStatus:"FT",dateEvent:"2025-08-01",strSport:"Handball",idHomeTeam:"3",strHomeTeam:"A",idAwayTeam:"4",strAwayTeam:"C",intHomeScore:"30",intAwayScore:"29"},
    {idEvent:"10",strStatus:"NS",dateEvent:"2025-08-02",strHomeTeam:"C",strAwayTeam:"D"}
  ]});}});
  assert.equal((await getFreeLeagueRoundEvents("1","2025-2026",1)).length,1);
  assert.equal((await getFreeLeagueRoundEvents("1","2025-2026",1)).length,1);
  assert.equal(calls,1);
});
