import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { teamIdentityLevel } from "../src/history/relaxedIdentity.js";
import { resolveHistoryMatch, matchHistoryRow } from "../src/history/resultMatching.js";
import { updateMarketBetHistory } from "../src/statistics/marketBetHistory.js";

// Cases below are real: they come from the 2026-10-27 Termux export, where 8
// settled bets stayed PENDING because providers spell clubs differently, and
// from a scan of every club name per competition in the real SQLite history
// (an open "subset" rule merged Los Angeles FC/Galaxy, Paris FC/PSG, Barcelona/Espanyol).

function pred(overrides={}){return {kickoff:"2026-10-10T14:00:00+00:00",home:"Bolton",away:"Stoke City",fixtureId:"1563180",competition:"Championship",...overrides};}
function row(overrides={}){
  return {recordKey:"SQLITE:1",playedAt:"2026-10-10T14:00:00.000Z",sourceFixtureId:"561866",status:"FINISHED",
    competition:{name:"Championship",code:"ELC"},homeTeam:{name:"Bolton Wanderers FC"},awayTeam:{name:"Stoke City FC"},
    score:{fullTime:{home:1,away:2}},provenance:{source:"FOOTBALL_DATA"},...overrides};
}

test("teamIdentityLevel: real same-club spelling variants are RELAXED (or STRICT)", () => {
  for (const [a,b] of [["Bolton","Bolton Wanderers FC"],["Swansea","Swansea City AFC"],["Blackburn","Blackburn Rovers FC"],
    ["Lincoln","Lincoln City FC"],["Preston","Preston North End FC"],["Sheffield Utd","Sheffield United FC"],["Vitoria","EC Vitória"],["Mirassol","Mirassol FC"]]) {
    assert.ok(["STRICT","RELAXED"].includes(teamIdentityLevel(a,b)), `${a} ~ ${b}`);
  }
  assert.equal(teamIdentityLevel("Stoke City","Stoke City FC"), "STRICT");
});

test("teamIdentityLevel: different clubs found in the real corpus are NOT merged", () => {
  for (const [a,b] of [["Los Angeles FC","Los Angeles Galaxy"],["Paris FC","Paris Saint-Germain FC"],["Barcelona","RCD Espanyol de Barcelona"],
    ["Sheffield United","Sheffield Wednesday"],["Club Nacional","CDC Atlético Nacional"],["Club Nacional","Club Nacional Potosí"],
    ["Vitoria","Vitória SC"],["Real Madrid","Real Madrid Castilla"],["Chelsea","Chelsea Women"],["Arsenal","Arsenal U21"],["Santos","Santos Laguna"],["Newcastle","Newcastle Jets"],["Sabah FA","Sabah FK"]]) {
    assert.equal(teamIdentityLevel(a,b), null, `${a} !~ ${b}`);
  }
});

test("RELAXED_NAME is opt-in: default resolver and matchHistoryRow stay strict", () => {
  assert.equal(matchHistoryRow(pred(), [row()]), null);
  assert.equal(resolveHistoryMatch(pred(), [row()]).reason, "NO_CANDIDATE");
  const relaxed = resolveHistoryMatch(pred(), [row()], { allowRelaxed: true });
  assert.equal(relaxed.matchType, "RELAXED_NAME");
  assert.deepEqual(relaxed.matched.score, { home: 1, away: 2 });
  assert.equal(relaxed.matched.kickoffDeltaMinutes, 0);
});

test("STRICT_NAME / STRICT_ID are reported and take precedence over relaxed", () => {
  const strictRow = row({ homeTeam:{name:"Bolton"}, recordKey:"SQLITE:2" });
  assert.equal(resolveHistoryMatch(pred(), [strictRow, row()], { allowRelaxed:true }).matchType, "STRICT_NAME");
  const idRow = row({ homeTeam:{name:"Totally Different"}, sourceFixtureId:"1563180", provenance:{source:"API_FOOTBALL"} });
  assert.equal(resolveHistoryMatch(pred(), [idRow], { allowRelaxed:true }).matchType, "STRICT_ID");
});

test("relaxed match is rejected on kickoff drift, unknown/other competition, swapped orientation and non-finished status", () => {
  const opts = { allowRelaxed:true };
  assert.equal(resolveHistoryMatch(pred(), [row({ playedAt:"2026-10-10T14:45:00.000Z" })], opts).row, null, ">30 min");
  assert.equal(resolveHistoryMatch(pred(), [row({ competition:{name:"Premier League",code:"PL"} })], opts).row, null, "other competition");
  assert.equal(resolveHistoryMatch(pred(), [row({ competition:{name:null,code:null} })], opts).row, null, "competition unverifiable");
  assert.equal(resolveHistoryMatch(pred(), [row({ homeTeam:{name:"Stoke City FC"}, awayTeam:{name:"Bolton Wanderers FC"} })], opts).row, null, "swapped home/away");
  assert.equal(resolveHistoryMatch(pred(), [row({ status:"PST" })], opts).row, null, "not finished");
});

test("ambiguous relaxed candidates are never graded", () => {
  const rows = [row({ recordKey:"A" }), row({ recordKey:"B", playedAt:"2026-10-10T14:10:00.000Z", score:{fullTime:{home:0,away:0}} })];
  const result = resolveHistoryMatch(pred(), rows, { allowRelaxed:true });
  assert.equal(result.row, null);
  assert.ok(["AMBIGUOUS_CANDIDATES","CONFLICTING_SCORES"].includes(result.reason));
});

test("the same fixture stored twice with the same score is not ambiguous; conflicting strict scores are", () => {
  const a = row({ recordKey:"A" }), b = row({ recordKey:"B", provenance:{source:"API_FOOTBALL"} });
  assert.equal(resolveHistoryMatch(pred(), [a, b], { allowRelaxed:true }).matchType, "RELAXED_NAME");
  const strictA = row({ homeTeam:{name:"Bolton"}, recordKey:"A", score:{fullTime:{home:1,away:3}} });
  const strictB = row({ homeTeam:{name:"Bolton"}, recordKey:"B", score:{fullTime:{home:0,away:3}} });
  const conflict = resolveHistoryMatch(pred(), [strictA, strictB]);
  assert.equal(conflict.row, null);
  assert.equal(conflict.reason, "CONFLICTING_SCORES");
});

function file(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-relaxed-grading-")),"bets.jsonl");}
function bet(){return {id:"1563180",utcDate:"2026-10-10T14:00:00Z",home:"Bolton",away:"Stoke City",competition:"Championship",category:"VALUE",dataQuality:76,stability:73,
  best:{market:"1X2",label:"П1",line:null,odds:2.82,probability:.575,marketFair:.352,edge:22.3,ev:62.1,confidence:72,fds:82,bookmaker:"Betfair"}};}
const read = target => fs.readFileSync(target,"utf8").split("\n").filter(Boolean).map(JSON.parse);

test("market bet history grades a relaxed match once, records provenance, never rewrites old events", () => {
  const target = file();
  updateMarketBetHistory(target,[bet()],[],"2026-10-10T10:00:00Z");
  const before = fs.readFileSync(target);
  const stats = updateMarketBetHistory(target,[],[row()],"2026-10-11T00:00:00Z");
  assert.equal(stats.completed, 1);
  assert.equal(stats.categories.VALUE.outcomes.LOSS, 1);
  const result = read(target).find(event => event.type === "MARKET_BET_RESULT");
  assert.equal(result.matchType, "RELAXED_NAME");
  assert.equal(result.matchedRecord.home, "Bolton Wanderers FC");
  assert.equal(result.unitProfit, -1);
  assert.ok(fs.readFileSync(target).subarray(0, before.length).equals(before), "append-only");
  const again = updateMarketBetHistory(target,[],[row()],"2026-10-12T00:00:00Z");
  assert.equal(again.completed, 1);
  assert.equal(read(target).filter(event => event.type === "MARKET_BET_RESULT").length, 1, "no duplicate result");
});

test("ambiguous history leaves the bet pending and writes one idempotent audit HOLD", () => {
  const target = file();
  updateMarketBetHistory(target,[bet()],[],"2026-10-10T10:00:00Z");
  const rows = [row({ recordKey:"A" }), row({ recordKey:"B", playedAt:"2026-10-10T14:10:00.000Z", score:{fullTime:{home:0,away:0}} })];
  const first = updateMarketBetHistory(target,[],rows,"2026-10-11T00:00:00Z");
  updateMarketBetHistory(target,[],rows,"2026-10-11T01:00:00Z");
  assert.equal(first.completed, 0);
  const holds = read(target).filter(event => event.type === "MARKET_BET_GRADING_HOLD");
  assert.equal(holds.length, 1);
  assert.ok(holds[0].candidates.length >= 2);
});
