import test from "node:test";
import assert from "node:assert/strict";
import { resolveContextProvenance, describeTeamStrengthSource } from "../src/history/contextProvenance.js";

// ============================================================================
// resolveContextProvenance — bug: getApiFootballCompetitionContext can
// resolve to null WITHOUT throwing (e.g. free-plan season restriction), so
// using "did an exception occur" as a proxy for "which provider supplied the
// data" mislabels a genuine Football-Data fallback as API_FOOTBALL.
// ============================================================================

test("API-Football -> null (no exception) -> Football-Data fallback is labeled FOOTBALL_DATA",()=>{
  const apiFootballContext=null; // resolved to null, not rejected — the exact free-plan-season shape
  const footballDataContext={standings:{standings:[]},finished:[{id:"m1"}],scheduled:[]};
  const result=resolveContextProvenance(apiFootballContext,footballDataContext);
  assert.equal(result.source,"FOOTBALL_DATA");
  assert.equal(result.context,footballDataContext);
});

test("API-Football succeeds -> labeled API_FOOTBALL, Football-Data never consulted",()=>{
  const apiFootballContext={standings:{standings:[]},finished:[],scheduled:[]};
  const result=resolveContextProvenance(apiFootballContext,null);
  assert.equal(result.source,"API_FOOTBALL");
  assert.equal(result.context,apiFootballContext);
});

test("both providers unavailable -> null context, null source (not silently API_FOOTBALL)",()=>{
  const result=resolveContextProvenance(null,null);
  assert.equal(result.source,null);
  assert.equal(result.context,null);
});

// ============================================================================
// describeTeamStrengthSource — bug: FALLBACK_TWO_TEAM was reported whenever
// local history ALSO happened to qualify (>=4 games each), even when
// baseContext.standings (a real live/Football-Data table) was what
// mergeWithLocalHistory actually kept via `context?.standings || local.standings`.
// ============================================================================

function footballDataStandings(){
  return {standings:[{type:"TOTAL",table:[
    {team:{id:4364,name:"Mirassol FC"},playedGames:24,goalsFor:30,goalsAgainst:20},
    {team:{id:1782,name:"EC Vitória"},playedGames:25,goalsFor:28,goalsAgainst:22}
  ]}]};
}

test("regression: a real Football-Data standings table is never reported as FALLBACK_TWO_TEAM",()=>{
  const standings=footballDataStandings();
  const baseContext={standings,finished:[],scheduled:[]};
  // mergeWithLocalHistory's own OR-fallback behaviour: since baseContext.standings
  // is truthy, `mergedContext.standings` stays the SAME object — this is exactly
  // what src/history/localHistory.js's mergeWithLocalHistory does, reproduced
  // here directly so this test does not depend on local-history match content.
  const mergedContext={standings,finished:[],scheduled:[],localHistoryMeta:{homeMatches:20,awayMatches:20,provenance:["FOOTBALL_DATA"]}};
  const rawContext={standings,finished:[],scheduled:[]};

  const result=describeTeamStrengthSource({
    competitionBaseline:null,
    rawBaseline:{sampleCurrentSeason:0,samplePreviousSeason:0},
    baseContext,mergedContext,rawContext,
    rawContextSource:"FOOTBALL_DATA",
    fallbackContextDiagnostic:{status:"OK",source:"FOOTBALL_DATA",standings:true,finished:0}
  });

  assert.notEqual(result.baselineDiagnostic.baselineSource,"FALLBACK_TWO_TEAM");
  assert.equal(result.baselineDiagnostic.baselineSource,"FOOTBALL_DATA");
  assert.equal(result.contextDiagnosticBase.source,"FOOTBALL_DATA");
  assert.equal(result.hasLocalModelContext,false);
});

test("FALLBACK_TWO_TEAM still fires when local history genuinely is the only source (baseContext.standings null)",()=>{
  const baseContext={standings:null,finished:[],scheduled:[]};
  const localStandings={standings:[{type:"TOTAL",table:[]}]};
  const mergedContext={standings:localStandings,finished:[],scheduled:[],localHistoryMeta:{homeMatches:5,awayMatches:6,provenance:["API_FOOTBALL"]}};
  const rawContext={standings:null,finished:[],scheduled:[]};

  const result=describeTeamStrengthSource({
    competitionBaseline:null,
    rawBaseline:{sampleCurrentSeason:0,samplePreviousSeason:0},
    baseContext,mergedContext,rawContext,
    rawContextSource:null,
    fallbackContextDiagnostic:{status:"UNAVAILABLE",reason:"NO_STANDINGS_OR_HISTORY"}
  });

  assert.equal(result.hasLocalModelContext,true);
  assert.equal(result.baselineDiagnostic.baselineSource,"FALLBACK_TWO_TEAM");
  assert.equal(result.baselineDiagnostic.baselineSample,11);
  assert.equal(result.contextDiagnosticBase.source,"LOCAL_HISTORY");
});

test("COMPETITION_BASELINE (SQLite) still takes priority over both live and local-history labels",()=>{
  const baseContext={standings:footballDataStandings(),finished:[],scheduled:[]};
  const mergedContext={standings:baseContext.standings,finished:[],scheduled:[],localHistoryMeta:{homeMatches:20,awayMatches:20,provenance:[]}};
  const rawContext={standings:null,finished:[],scheduled:[]};
  const competitionBaseline={baselineSource:"CURRENT_SEASON",baselineSample:250,baselineTeams:26};

  const result=describeTeamStrengthSource({
    competitionBaseline,
    rawBaseline:{sampleCurrentSeason:250,samplePreviousSeason:0},
    baseContext,mergedContext,rawContext,
    rawContextSource:null,
    fallbackContextDiagnostic:null
  });

  assert.equal(result.baselineDiagnostic.baselineSource,"CURRENT_SEASON");
  assert.equal(result.contextDiagnosticBase.source,"COMPETITION_BASELINE");
});

test("no standings anywhere -> NONE, never mislabeled as a fallback of either kind",()=>{
  const baseContext={standings:null,finished:[],scheduled:[]};
  const mergedContext={standings:null,finished:[],scheduled:[],localHistoryMeta:{homeMatches:1,awayMatches:1,provenance:[]}};
  const rawContext={standings:null,finished:[],scheduled:[]};

  const result=describeTeamStrengthSource({
    competitionBaseline:null,
    rawBaseline:{sampleCurrentSeason:0,samplePreviousSeason:0},
    baseContext,mergedContext,rawContext,
    rawContextSource:null,
    fallbackContextDiagnostic:{status:"UNAVAILABLE",reason:"NO_CONTEXT_MAPPING"}
  });

  assert.equal(result.hasLocalModelContext,false);
  assert.equal(result.baselineDiagnostic.baselineSource,"NONE");
});
