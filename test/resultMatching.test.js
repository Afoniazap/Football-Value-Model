import test from "node:test";
import assert from "node:assert/strict";
import { matchHistoryRow } from "../src/history/resultMatching.js";

// Shared identity matcher used by predictionHistory.js, marketBetHistory.js
// and dualShadow.js. Forensic audit basis: Utrecht vs Go Ahead Eagles,
// API-Football fixtureId 1552155, status INT (interrupted) on 2026-09-05 ->
// FT (finished) on 2026-09-08 (+3 days), same venue/referee confirmed via
// our own provider cache; plus two real PST(postponed)->FT reschedules at
// +7 days each and one PST->NS->FT at +15 days.

function prediction({kickoff="2026-09-05T16:45:00+00:00",home="Utrecht",away="GO Ahead Eagles",fixtureId="1552155"}={}){
  return {kickoff,home,away,fixtureId};
}
function row({playedAt,home="FC Utrecht",away="Go Ahead Eagles",sourceFixtureId="1552155",source="API_FOOTBALL",status="FT"}){
  return {playedAt,homeTeam:{name:home},awayTeam:{name:away},sourceFixtureId,provenance:{source},status};
}

test("A) Utrecht: тот же API-Football fixtureId, INT->FT, +3 дня -> match",()=>{
  const match = matchHistoryRow(prediction(), [row({playedAt:"2026-09-08T12:00:00Z"})]);
  assert.ok(match, "same source+fixtureId must match despite +3 days");
  assert.equal(match.sourceFixtureId,"1552155");
});

test("B) PST->FT +7 дней -> match",()=>{
  const match = matchHistoryRow(
    prediction({kickoff:"2026-09-08T16:00:00Z",fixtureId:"1600773"}),
    [row({playedAt:"2026-09-15T16:00:00Z",sourceFixtureId:"1600773"})]
  );
  assert.ok(match);
});

test("B) PST->NS->FT +15 дней -> match",()=>{
  const match = matchHistoryRow(
    prediction({kickoff:"2026-09-04T13:00:00Z",fixtureId:"1619558"}),
    [row({playedAt:"2026-09-19T13:00:00Z",sourceFixtureId:"1619558"})]
  );
  assert.ok(match);
});

test("C) тот же fixtureId, +31 день -> reject (за пределами 30-дневного потолка)",()=>{
  const match = matchHistoryRow(
    prediction(),
    [row({playedAt:"2026-10-06T16:45:00Z"})] // +31 days
  );
  assert.equal(match,null);
});

test("D) тот же numeric ID, но другой provider -> reject",()=>{
  const match = matchHistoryRow(
    prediction(),
    [row({playedAt:"2026-09-08T12:00:00Z",source:"FOOTBALL_DATA"})]
  );
  assert.equal(match,null,"a numeric ID collision across providers must never be trusted without a matching source");
});

test("E) другой fixtureId, одинаковые команды, +3 дня -> reject",()=>{
  const match = matchHistoryRow(
    prediction(),
    [row({playedAt:"2026-09-08T12:00:00Z",sourceFixtureId:"9999999"})]
  );
  assert.equal(match,null,"a different fixtureId must fall back to the 12h name-path window, which +3 days does not satisfy");
});

test("F) только имя (без ID), +3 дня -> reject",()=>{
  const match = matchHistoryRow(
    {kickoff:"2026-09-05T16:45:00+00:00",home:"Utrecht",away:"GO Ahead Eagles",fixtureId:null},
    [row({playedAt:"2026-09-08T12:00:00Z",sourceFixtureId:"1552155"})]
  );
  assert.equal(match,null,"without a prediction fixtureId to anchor on, name-only matching must stay within 12h");
});

test("G) ABD/CANC/нефинальные статусы не грейдятся, даже с точным ID",()=>{
  for (const status of ["ABD","CANC","PST","SUSP","INT","NS"]) {
    const match = matchHistoryRow(prediction(), [row({playedAt:"2026-09-08T12:00:00Z",status})]);
    assert.equal(match,null,`status ${status} must never be treated as a valid result`);
  }
});

test("H) обычный existing <=12h grading не меняется (и по ID, и по имени)",()=>{
  const byId = matchHistoryRow(prediction(), [row({playedAt:"2026-09-05T18:00:00Z"})]);
  assert.ok(byId);
  const byName = matchHistoryRow(
    {kickoff:"2026-09-05T16:45:00+00:00",home:"Utrecht",away:"GO Ahead Eagles",fixtureId:null},
    [row({playedAt:"2026-09-05T18:00:00Z",sourceFixtureId:"different"})]
  );
  assert.ok(byName);
});

test("не подменяет home/away ориентацию даже при точном ID-совпадении",()=>{
  const match = matchHistoryRow(
    prediction(),
    [row({playedAt:"2026-09-08T12:00:00Z",home:"Go Ahead Eagles",away:"FC Utrecht"})]
  );
  // exact-ID path in this module intentionally does not re-check orientation
  // -- the fixtureId itself is the identity. This test documents that choice
  // explicitly rather than leaving it implicit.
  assert.ok(match,"exact fixtureId is treated as sufficient identity regardless of which side is listed as home in the stored row");
});
