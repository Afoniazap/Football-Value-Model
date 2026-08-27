import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureTheSportsDb, exactTeamMatch, getFreeTeamPreviousEvents, getTheSportsDbTelemetry, resetTheSportsDbTelemetry } from "../src/connectors/theSportsDb.js";

function response(data) { return { ok: true, json: async () => data }; }

test("TheSportsDB mapping принимает только одно точное нормализованное имя", () => {
  assert.equal(exactTeamMatch("FC Benfica", [{ idTeam: "1", strTeam: "Benfica" }]).idTeam, "1");
  assert.equal(exactTeamMatch("Aarhus", [{ idTeam: "1", strTeam: "AGF Aarhus" }]).idTeam, "1");
  assert.equal(exactTeamMatch("Aarhus", [{ idTeam: "2", strTeam: "Aarhus Fremad" }]), null);
  assert.equal(exactTeamMatch("Benfica", [{ idTeam: "1", strTeam: "Benfica" }, { idTeam: "2", strTeam: "Benfica FC" }]), null);
});

test("TheSportsDB previous events нормализуются и используют persistent cache", async () => {
  const calls = [];
  configureTheSportsDb({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "fvm-tsdb-")), minGapMs: 0, fetchImpl: async url => {
    calls.push(url);
    return url.includes("searchteams") ? response({ teams: [{ idTeam: "10", strTeam: "Benfica" }] }) : response({ results: [
      { idEvent: "7", strStatus: "FT", dateEvent: "2026-08-20", strTime: "19:00:00", idLeague: "1", strLeague: "League", idHomeTeam: "10", strHomeTeam: "Benfica", idAwayTeam: "20", strAwayTeam: "B", intHomeScore: "2", intAwayScore: "0" },
      { idEvent: "8", strStatus: "NS", dateEvent: "2026-08-30", strHomeTeam: "Benfica", strAwayTeam: "C" }
    ] });
  }});
  resetTheSportsDbTelemetry();
  assert.equal((await getFreeTeamPreviousEvents("Benfica")).matches.length, 1);
  assert.equal((await getFreeTeamPreviousEvents("Benfica")).matches.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(getTheSportsDbTelemetry().cacheHits, 2);
});
