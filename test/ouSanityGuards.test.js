import test from "node:test";
import assert from "node:assert/strict";
import { analyseFixture } from "../src/engine/analyse.js";

const config={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:0};
const fixture={id:"g",homeId:1,awayId:2,home:"Alpha",away:"Beta",utcDate:"2026-08-30T18:00:00Z"};
const match=(id,homeId,awayId)=>({id,utcDate:`2026-08-${10+id}T18:00:00Z`,homeTeam:{id:homeId,name:homeId===1?"Alpha":"Opponent"},awayTeam:{id:awayId,name:awayId===2?"Beta":"Opponent"},score:{fullTime:{home:1,away:0}}});

// Section 14: both λ clamps hit their data floor simultaneously (0.25/0.20) is
// the exact, reproduced root cause behind implausible "91%+" OU readings on
// thin/degenerate context — must surface as an explicit red flag.
test("EXTREME_EXPECTED_GOALS fires when both lambdas collapse to their clamp floor", () => {
  const table=[
    {team:{id:1,name:"Alpha"},playedGames:5,goalsFor:1,goalsAgainst:1},
    {team:{id:2,name:"Beta"},playedGames:5,goalsFor:1,goalsAgainst:1}
  ];
  const context={standings:{standings:[{type:"TOTAL",table}]},finished:[]};
  const result=analyseFixture(fixture,context,null,config,null);
  assert.ok(result.redFlags.some(f=>f.startsWith("EXTREME_EXPECTED_GOALS")), JSON.stringify(result.redFlags));
});

test("EXTREME_EXPECTED_GOALS does not fire for an ordinary, non-degenerate context", () => {
  const table=[
    {team:{id:1,name:"Alpha"},playedGames:8,goalsFor:12,goalsAgainst:8},
    {team:{id:2,name:"Beta"},playedGames:8,goalsFor:9,goalsAgainst:10}
  ];
  const context={standings:{standings:[{type:"TOTAL",table}]},finished:[]};
  const result=analyseFixture(fixture,context,null,config,null);
  assert.ok(!result.redFlags.some(f=>f.startsWith("EXTREME_EXPECTED_GOALS")));
});

// Section 14: model near-certain (fairOdds<=1.05) while the market prices the
// same selection as a longshot (odds>=4) means model and market are pricing
// different events, not that a genuine edge was found.
test("EXTREME_MODEL_MARKET_DISAGREEMENT fires on a >4x fair/market gap", () => {
  const table=[
    {team:{id:1,name:"Alpha"},playedGames:10,goalsFor:26,goalsAgainst:18},
    {team:{id:2,name:"Beta"},playedGames:10,goalsFor:24,goalsAgainst:15}
  ];
  const context={standings:{standings:[{type:"TOTAL",table}]},finished:[]};
  const oddsData={
    bookmakers:[{name:"Book",h2h:{home:1.9,draw:3.6,away:4.2},totals:[{name:"Over",point:0.5,odds:4.5},{name:"Under",point:0.5,odds:1.05}],spreads:[]}],
    best:{
      h2h:{home:{odds:1.9,bookmaker:"Book"},draw:{odds:3.6,bookmaker:"Book"},away:{odds:4.2,bookmaker:"Book"}},
      totals:{"Over|0.5":{odds:4.5,bookmaker:"Book",point:0.5,name:"Over"},"Under|0.5":{odds:1.05,bookmaker:"Book",point:0.5,name:"Under"}},
      spreads:{}
    }
  };
  const result=analyseFixture(fixture,context,oddsData,config,null);
  const over=result.markets.find(m=>m.label==="ТБ 0.5");
  assert.ok(over.fairOdds<=1.05 && over.odds>=4, "fixture must reproduce the gap it claims to test");
  assert.ok(result.redFlags.some(f=>f.startsWith("EXTREME_MODEL_MARKET_DISAGREEMENT")), JSON.stringify(result.redFlags));
});

// Section 12: OU/AH totals are priced solely from Team Strength's score
// matrix (formModel never contributes to it — see models.js), so the blended
// 1X2 model-agreement/stability must not be borrowed into OU/AH confidence.
test("OU candidates do not inherit 1X2's model agreement/stability into confidence", () => {
  const table=[
    {team:{id:1,name:"Alpha"},playedGames:8,goalsFor:12,goalsAgainst:8,points:14},
    {team:{id:2,name:"Beta"},playedGames:8,goalsFor:9,goalsAgainst:10,points:10}
  ];
  const finished=[];
  for(let id=1;id<=4;id++)finished.push(match(id,1,9+id),match(id+4,9+id,2));
  const context={standings:{standings:[{type:"TOTAL",table},{type:"HOME",table},{type:"AWAY",table}]},finished,scheduled:[]};
  const oddsData={
    bookmakers:[{name:"Book",h2h:{home:2.0,draw:3.4,away:3.8},totals:[{name:"Over",point:2.5,odds:1.9},{name:"Under",point:2.5,odds:1.9}],spreads:[]}],
    best:{
      h2h:{home:{odds:2.0,bookmaker:"Book"},draw:{odds:3.4,bookmaker:"Book"},away:{odds:3.8,bookmaker:"Book"}},
      totals:{"Over|2.5":{odds:1.9,bookmaker:"Book",point:2.5,name:"Over"},"Under|2.5":{odds:1.9,bookmaker:"Book",point:2.5,name:"Under"}},
      spreads:{}
    }
  };
  const result=analyseFixture(fixture,context,oddsData,config,null);
  assert.ok(Number.isFinite(result.consensusScore) && result.consensusScore>0, "fixture must have a real multi-model 1X2 consensus to make this a meaningful test");

  const h2hCandidate=result.markets.find(m=>m.market==="1X2");
  const ouCandidate=result.markets.find(m=>m.market==="OU");
  assert.ok(h2hCandidate.confidenceParts.consensus>0, "1X2 confidence must still use the real multi-model consensus");
  assert.equal(ouCandidate.confidenceParts.consensus,0);
  assert.equal(ouCandidate.confidenceParts.stability,0);

  assert.equal(result.ouModelCoverage,0.5);
  assert.equal(result.ouModelAgreement,null);
  assert.equal(result.ouStability,null);

  // Section 16: DNB/BTTS candidates carry no bookmaker price (status:"WAIT_ODDS",
  // edge/ev:null) — analyseFixture's `priced` filter must exclude them so a
  // null-edge candidate can never win the fds sort and become `best`.
  assert.ok(!result.markets.some(m=>m.status==="WAIT_ODDS"), "unpriced candidates must not enter the ranked/best market list");
  assert.ok(Number.isFinite(result.best.edge) && Number.isFinite(result.best.ev));
});

// Section 22 acceptance criterion: "invalid candidates cannot dominate best
// market". A degraded-λ OU/AH candidate must never win `best` — and
// therefore never reach VALUE — no matter how attractive its (equally
// degenerate) edge/EV/FDS look. Thresholds are left at 0 deliberately: this
// proves the block is structural (an eligibility filter on `best`), not an
// accident of strict gates.
test("a degraded-λ OU/AH candidate cannot become best or VALUE even with an enormous edge/EV", () => {
  const permissive={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:0};
  const table=[
    {team:{id:1,name:"Alpha"},playedGames:5,goalsFor:1,goalsAgainst:1},
    {team:{id:2,name:"Beta"},playedGames:5,goalsFor:1,goalsAgainst:1}
  ];
  const context={standings:{standings:[{type:"TOTAL",table}]},finished:[]};
  const oddsData={
    bookmakers:[{name:"Book",h2h:{home:2.0,draw:3.4,away:3.8},
      totals:[{name:"Over",point:0.5,odds:1.05},{name:"Under",point:0.5,odds:6.5}],spreads:[]}],
    best:{
      h2h:{home:{odds:2.0,bookmaker:"Book"},draw:{odds:3.4,bookmaker:"Book"},away:{odds:3.8,bookmaker:"Book"}},
      totals:{"Over|0.5":{odds:1.05,bookmaker:"Book",point:0.5,name:"Over"},"Under|0.5":{odds:6.5,bookmaker:"Book",point:0.5,name:"Under"}},
      spreads:{}
    }
  };
  const result=analyseFixture(fixture,context,oddsData,permissive,null);
  const degradedOU=result.markets.filter(m=>m.market==="OU").sort((a,b)=>b.fds-a.fds)[0];
  assert.ok(degradedOU.edge>40 && degradedOU.ev>200, "fixture must reproduce a deliberately extreme, attractive-looking OU candidate");
  assert.ok(degradedOU.fds>=(result.best?.fds??0), "the degraded candidate must genuinely outscore best on raw FDS to make this test meaningful");
  assert.notEqual(result.best?.market,"OU");
  assert.notEqual(result.best?.market,"AH");
  // With every threshold at 0, VALUE is reachable in principle — the point is
  // WHO reaches it: never the degraded OU/AH candidate itself.
  if (result.category==="VALUE") assert.equal(result.best.market,"1X2");
});

// Section 4 requirement: sanity guards must not block ordinary, non-degenerate
// OU across a spread of total-goal expectations and common lines.
test("sanity guards do not fire false positives across normal OU scenarios", () => {
  const permissive={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:0};
  const lambdaTargets=[1.5,2.0,2.5,3.0,3.5];
  const lines=[1.5,2.0,2.25,2.5,2.75,3.0,3.5];
  let checked=0;
  for (const lambdaTotal of lambdaTargets) {
    const leagueGoalsPerTeam=(lambdaTotal*0.52)/1.08;
    const gp=10, gf=Math.round(leagueGoalsPerTeam*gp);
    const table=[
      {team:{id:1,name:"Alpha"},playedGames:gp,goalsFor:gf,goalsAgainst:gf},
      {team:{id:2,name:"Beta"},playedGames:gp,goalsFor:gf,goalsAgainst:gf}
    ];
    const finished=[];
    for(let id=1;id<=4;id++)finished.push(match(id,1,9+id),match(id+4,9+id,2));
    const context={standings:{standings:[{type:"TOTAL",table},{type:"HOME",table},{type:"AWAY",table}]},finished};
    for (const line of lines) {
      const oddsData={
        bookmakers:[{name:"Book",h2h:{home:2.2,draw:3.3,away:3.2},totals:[{name:"Over",point:line,odds:1.9},{name:"Under",point:line,odds:1.9}],spreads:[]}],
        best:{
          h2h:{home:{odds:2.2,bookmaker:"Book"},draw:{odds:3.3,bookmaker:"Book"},away:{odds:3.2,bookmaker:"Book"}},
          totals:{[`Over|${line}`]:{odds:1.9,bookmaker:"Book",point:line,name:"Over"},[`Under|${line}`]:{odds:1.9,bookmaker:"Book",point:line,name:"Under"}},
          spreads:{}
        }
      };
      const result=analyseFixture(fixture,context,oddsData,permissive,null);
      const ouCandidates=result.markets.filter(m=>m.market==="OU"&&m.line===line);
      assert.equal(ouCandidates.length,2,`λtotal ${lambdaTotal} line ${line}: both Over/Under must price`);
      for (const c of ouCandidates) {
        assert.ok(Number.isFinite(c.fairOdds)&&c.fairOdds>1,`λtotal ${lambdaTotal} line ${line}: fairOdds must be a real number >1`);
        assert.ok(Number.isFinite(c.ev),`λtotal ${lambdaTotal} line ${line}: EV must be finite`);
      }
      assert.ok(!result.redFlags.some(f=>f.startsWith("EXTREME_EXPECTED_GOALS")),`λtotal ${lambdaTotal} line ${line}: false EXTREME_EXPECTED_GOALS`);
      assert.ok(!result.redFlags.some(f=>f.startsWith("EXTREME_MODEL_MARKET_DISAGREEMENT")),`λtotal ${lambdaTotal} line ${line}: false EXTREME_MODEL_MARKET_DISAGREEMENT`);
      checked++;
    }
  }
  assert.equal(checked,35);
});

// Section 3 ranking requirement: when a match has both a degraded-λ OU and a
// normal 1X2 candidate, the degraded OU must not win `best` even though its
// (equally degenerate) FDS is the same as or higher than the legitimate 1X2.
// 1X2 here is genuinely "normal" (not single-model-degraded): a form model
// is available, so consensus.probability is diluted by an independent
// estimate, not read straight off the degenerate matrix.
test("ranking never lets a degraded OU outrank a normal 1X2 for best", () => {
  const permissive={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:0};
  const table=[
    {team:{id:1,name:"Alpha"},playedGames:5,goalsFor:1,goalsAgainst:1},
    {team:{id:2,name:"Beta"},playedGames:5,goalsFor:1,goalsAgainst:1}
  ];
  const finished=[];
  for(let id=1;id<=4;id++)finished.push(match(id,1,9+id),match(id+4,9+id,2));
  const context={standings:{standings:[{type:"TOTAL",table}]},finished};
  const oddsData={
    bookmakers:[{name:"Book",h2h:{home:5.0,draw:3.4,away:1.5},
      totals:[{name:"Over",point:0.5,odds:1.05},{name:"Under",point:0.5,odds:6.5}],spreads:[]}],
    best:{
      h2h:{home:{odds:5.0,bookmaker:"Book"},draw:{odds:3.4,bookmaker:"Book"},away:{odds:1.5,bookmaker:"Book"}},
      totals:{"Over|0.5":{odds:1.05,bookmaker:"Book",point:0.5,name:"Over"},"Under|0.5":{odds:6.5,bookmaker:"Book",point:0.5,name:"Under"}},
      spreads:{}
    }
  };
  const result=analyseFixture(fixture,context,oddsData,permissive,null);
  assert.equal(result.modelsAvailable,2,"1X2 must genuinely blend a form model to make this test meaningful");
  const degradedOU=result.markets.filter(m=>m.market==="OU").sort((a,b)=>b.fds-a.fds)[0];
  const normal1x2=result.markets.filter(m=>m.market==="1X2").sort((a,b)=>b.fds-a.fds)[0];
  assert.ok(degradedOU.fds>=normal1x2.fds, "fixture must reproduce the degraded OU at least matching 1X2's FDS to make this test meaningful");
  assert.equal(result.best?.market,"1X2");
  assert.equal(result.best?.label,normal1x2.label);
});

// 09.09 forensic audit: production showed a repeated "X 67%" draw across
// unrelated fixtures (Barcelona-Feyenoord, Stuttgart-Viking, PSG-Slovan
// Bratislava, Napoli-Arsenal...), all FDS 35. Reproduced end-to-end: a thin
// two-row TOTAL table (gf=ga=1 over 5 games, both teams) collapses both λ to
// their floor (0.25/0.20) with no form model available (single-model
// consensus) — the raw degenerate matrix's P(draw)=66.99% then had nothing
// diluting it and could win `best`. Must now be excluded the same way
// degraded OU/AH already are.
test("a single-model degraded draw (the reproduced 09.09 '67% draw') cannot become best", () => {
  const permissive={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:0};
  const table=[
    {team:{id:1,name:"Barcelona"},playedGames:5,goalsFor:1,goalsAgainst:1},
    {team:{id:2,name:"Feyenoord"},playedGames:5,goalsFor:1,goalsAgainst:1}
  ];
  const context={standings:{standings:[{type:"TOTAL",table}]},finished:[]};
  const oddsData={
    bookmakers:[{name:"Book",h2h:{home:1.12,draw:14.8,away:9.0},totals:[],spreads:[]}],
    best:{h2h:{home:{odds:1.12,bookmaker:"Book"},draw:{odds:14.8,bookmaker:"Book"},away:{odds:9.0,bookmaker:"Book"}},totals:{},spreads:{}}
  };
  const result=analyseFixture(fixture,context,oddsData,permissive,null);
  assert.equal(result.modelsAvailable,1,"fixture must reproduce the real single-model (no form) condition");
  const draw=result.markets.find(m=>m.label==="X");
  assert.ok(Math.abs(draw.probability-0.6699)<1e-3, `must reproduce the reported 67% draw, got ${draw.probability}`);
  assert.ok(result.redFlags.some(f=>f.startsWith("EXTREME_EXPECTED_GOALS")));
  assert.notEqual(result.best?.label,"X");
});

// Symmetric ceiling case (09.09 audit): Minnesota United-FC Dallas's reported
// "TB 5 Fair 1.36" is reproduced exactly by BOTH λ hitting their ceiling
// (3.4/3.1) at once — the mirror image of the floor collapse, and previously
// undetected because the guard only checked the floor.
test("EXTREME_EXPECTED_GOALS also fires on the ceiling (both lambdas maxed), not just the floor", () => {
  // Both teams score AND concede heavily relative to the (self-referential,
  // two-row) league average — pushes both lambdaHome and lambdaAway past
  // their respective ceiling (3.4 / 3.1), where the clamp then saturates them.
  const table=[
    {team:{id:1,name:"Minnesota United"},playedGames:3,goalsFor:30,goalsAgainst:30},
    {team:{id:2,name:"FC Dallas"},playedGames:3,goalsFor:30,goalsAgainst:30}
  ];
  const context={standings:{standings:[{type:"TOTAL",table}]},finished:[]};
  const result=analyseFixture(fixture,context,null,{minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:0},null);
  assert.ok(result.redFlags.some(f=>f.startsWith("EXTREME_EXPECTED_GOALS")), JSON.stringify(result.redFlags));
});
