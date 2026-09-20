import test from "node:test";
import assert from "node:assert/strict";
import { analyseFixture } from "../src/engine/analyse.js";
import { scheduleCongestion } from "../src/engine/models.js";

// ============================================================================
// 1) OU/AH Stability gate semantics.
//
// OU/AH are priced solely from Team Strength's score matrix (models.js —
// formModel never contributes to it), so the fixture-level `stability`
// (derived from cons.agreement, the TS/Form 1X2 disagreement) is not
// evidence about an OU/AH candidate. Before this fix, analyseFixture's VALUE
// gate unconditionally required `stability >= config.minStability` even when
// `best.market` was OU/AH, silently reusing an unrelated market's figure.
//
// Swinging Form between "agrees with Team Strength" (high global stability)
// and "disagrees with Team Strength" (low global stability) changes ONLY
// cons.agreement/stability — OU/AH's own edge/ev/fairOdds never move, since
// they never read consensus.probability or Form at all. That lets the tests
// below isolate the gate's effect precisely.
// ============================================================================

const fixture={id:"gate",homeId:1,awayId:2,home:"Alpha",away:"Beta",competition:"League",utcDate:"2026-09-10T18:00:00Z"};
const table=[
  {team:{id:1,name:"Alpha"},playedGames:8,goalsFor:16,goalsAgainst:8,points:16},
  {team:{id:2,name:"Beta"},playedGames:8,goalsFor:8,goalsAgainst:16,points:8}
];
const match=(id,homeId,awayId,homeGoals,awayGoals)=>({id,utcDate:`2026-08-${String(10+id).padStart(2,"0")}T18:00:00Z`,homeTeam:{id:homeId,name:`Team ${homeId}`},awayTeam:{id:awayId,name:`Team ${awayId}`},score:{fullTime:{home:homeGoals,away:awayGoals}}});
const context=finished=>({standings:{standings:[{type:"TOTAL",table},{type:"HOME",table},{type:"AWAY",table}]},finished,scheduled:[]});

// Form's recent results agree with Team Strength (both favour Alpha) -> high cons.agreement -> high global stability.
const highAgreementFinished=[];
for(let id=1;id<=4;id++)highAgreementFinished.push(match(id,1,10+id,2,1),match(id+4,20+id,2,1,1));

// Form's recent results oppose Team Strength (Form favours Beta while the standings table still favours Alpha) -> low cons.agreement -> low global stability.
const lowAgreementFinished=[];
for(let id=1;id<=4;id++)lowAgreementFinished.push(match(id,1,10+id,0,2),match(id+4,20+id,2,0,2));

const h2hOdds={home:{odds:2.0,bookmaker:"Book"},draw:{odds:3.4,bookmaker:"Book"},away:{odds:3.8,bookmaker:"Book"}};
const h2hBookmaker={home:2.0,draw:3.4,away:3.8};

// Each odds fixture supplies exactly one priced market family so `best` is
// unambiguous and never a ranking artefact between markets.
const ouOnlyOdds={
  bookmakers:[{name:"Book",h2h:{},totals:[{name:"Over",point:2.5,odds:1.9},{name:"Under",point:2.5,odds:1.9}],spreads:[]}],
  best:{h2h:{},totals:{"Over|2.5":{odds:1.9,bookmaker:"Book",point:2.5,name:"Over"},"Under|2.5":{odds:1.9,bookmaker:"Book",point:2.5,name:"Under"}},spreads:{}}
};
const ahOnlyOdds={
  bookmakers:[{name:"Book",h2h:{},totals:[],spreads:[{name:"Alpha",point:-0.5,odds:2.0},{name:"Beta",point:0.5,odds:1.85}]}],
  best:{h2h:{},totals:{},spreads:{"Alpha|-0.5":{name:"Alpha",point:-0.5,odds:2.0,bookmaker:"Book"},"Beta|0.5":{name:"Beta",point:0.5,odds:1.85,bookmaker:"Book"}}}
};
const h2hOnlyOdds={
  bookmakers:[{name:"Book",h2h:h2hBookmaker,totals:[],spreads:[]}],
  best:{h2h:h2hOdds,totals:{},spreads:{}}
};

test("A) 1X2 продолжает требовать Stability — низкая global Stability блокирует VALUE",()=>{
  const gated={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:70};
  const low=analyseFixture(fixture,context(lowAgreementFinished),h2hOnlyOdds,gated,null);
  assert.equal(low.best.market,"1X2");
  assert.ok(low.stability<70,`fixture must reproduce a genuinely low global stability, got ${low.stability}`);
  assert.notEqual(low.category,"VALUE","1X2 must still be blocked by its own genuinely low Stability");

  const high=analyseFixture(fixture,context(highAgreementFinished),h2hOnlyOdds,gated,null);
  assert.ok(high.stability>=70,`fixture must reproduce a genuinely high global stability, got ${high.stability}`);
  assert.equal(high.category,"VALUE","the same 1X2 candidate must pass once Stability genuinely clears the threshold");
});

test("B) OU с валидной Team Strength и низкой global Stability не блокируется — market-specific Stability = N/A",()=>{
  const gated={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:70};
  const low=analyseFixture(fixture,context(lowAgreementFinished),ouOnlyOdds,gated,null);
  assert.equal(low.best.market,"OU");
  assert.ok(low.stability<70,`fixture must reproduce a genuinely low global stability, got ${low.stability}`);
  assert.equal(low.category,"VALUE","OU must not be blocked by a 1X2 Stability figure that does not describe it");
});

test("C) OU не получает ложный PASS благодаря высокой 1X2 Stability — свои gates всё ещё применяются",()=>{
  // minStability is irrelevant here (permissive) — the point is that a high
  // GLOBAL stability must not paper over OU genuinely failing its own edge gate.
  const strictEdge={minDataQuality:0,minEdge:25,minEv:0,minConfidence:0,minStability:0};
  const high=analyseFixture(fixture,context(highAgreementFinished),ouOnlyOdds,strictEdge,null);
  assert.equal(high.best.market,"OU");
  assert.ok(high.stability>=70,`fixture must reproduce a genuinely high global stability, got ${high.stability}`);
  assert.ok(high.best.edge<25,"fixture must reproduce an OU candidate that genuinely fails its own Edge gate");
  assert.notEqual(high.category,"VALUE","a high but irrelevant 1X2 Stability must not rescue a candidate that fails its own gates");
});

test("D) AH — то же самое, что и для OU (низкая global Stability не блокирует)",()=>{
  const gated={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:70};
  const low=analyseFixture(fixture,context(lowAgreementFinished),ahOnlyOdds,gated,null);
  assert.equal(low.best.market,"AH");
  assert.ok(low.stability<70,`fixture must reproduce a genuinely low global stability, got ${low.stability}`);
  assert.equal(low.category,"VALUE","AH must not be blocked by a 1X2 Stability figure that does not describe it");
});

test("OU/AH edge, ev и fairOdds не зависят от Form/global stability (score matrix — только Team Strength)",()=>{
  const permissive={minDataQuality:0,minEdge:0,minEv:0,minConfidence:0,minStability:0};
  const ouLow=analyseFixture(fixture,context(lowAgreementFinished),ouOnlyOdds,permissive,null);
  const ouHigh=analyseFixture(fixture,context(highAgreementFinished),ouOnlyOdds,permissive,null);
  assert.equal(ouLow.best.edge,ouHigh.best.edge);
  assert.equal(ouLow.best.ev,ouHigh.best.ev);
  assert.equal(ouLow.best.fairOdds,ouHigh.best.fairOdds);
  assert.notEqual(ouLow.stability,ouHigh.stability,"the two scenarios must genuinely differ in global stability to make this comparison meaningful");
});

// ============================================================================
// 2) SCI rest calculation must use the fixture's own kickoff, not Date.now().
// ============================================================================

const matchAt=(teamId,utcDate)=>({id:`t${teamId}-${utcDate}`,utcDate,homeTeam:{id:teamId,name:"H"},awayTeam:{id:99,name:"Away"},score:{fullTime:{home:1,away:0}}});

test("A) rest = fixture kickoff минус kickoff последнего матча",()=>{
  const fx={homeId:1,awayId:2,utcDate:"2026-09-14T20:00:00Z"};
  const ctx={finished:[matchAt(1,"2026-09-10T20:00:00Z"),matchAt(2,"2026-09-10T20:00:00Z")]};
  const sci=scheduleCongestion(fx,ctx);
  assert.ok(sci.known);
  assert.equal(sci.restDays.home,4);
  assert.equal(sci.restDays.away,4);
});

test("B) изменение системного времени не меняет SCI для одного и того же fixture/context",()=>{
  const fx={homeId:1,awayId:2,utcDate:"2026-09-14T20:00:00Z"};
  const ctx={finished:[matchAt(1,"2026-09-10T20:00:00Z"),matchAt(2,"2026-09-08T20:00:00Z")]};
  const before=scheduleCongestion(fx,ctx);
  const realNow=Date.now;
  Date.now=()=>new Date("2030-01-01T00:00:00Z").getTime();
  try {
    const after=scheduleCongestion(fx,ctx);
    assert.deepEqual(after,before,"SCI must be a pure function of fixture kickoff + context, not wall-clock time");
  } finally {
    Date.now=realNow;
  }
});

test("C) разный fixture kickoff при одинаковом last match корректно меняет rest",()=>{
  const ctx={finished:[matchAt(1,"2026-09-10T20:00:00Z"),matchAt(2,"2026-09-10T20:00:00Z")]};
  const soon=scheduleCongestion({homeId:1,awayId:2,utcDate:"2026-09-12T20:00:00Z"},ctx);
  const later=scheduleCongestion({homeId:1,awayId:2,utcDate:"2026-09-20T20:00:00Z"},ctx);
  assert.equal(soon.restDays.home,2);
  assert.equal(later.restDays.home,10);
  assert.notEqual(soon.score,later.score);
});

test("D) матч после fixture kickoff не используется как last match",()=>{
  const fx={homeId:1,awayId:2,utcDate:"2026-09-14T20:00:00Z"};
  const ctxWithFutureNoise={finished:[
    matchAt(1,"2026-09-10T20:00:00Z"), // genuine last match before kickoff -> rest = 4
    matchAt(1,"2026-09-16T20:00:00Z"), // AFTER kickoff -- must be ignored
    matchAt(2,"2026-09-11T20:00:00Z")
  ]};
  const withNoise=scheduleCongestion(fx,ctxWithFutureNoise);
  const ctxClean={finished:[matchAt(1,"2026-09-10T20:00:00Z"),matchAt(2,"2026-09-11T20:00:00Z")]};
  const clean=scheduleCongestion(fx,ctxClean);
  assert.deepEqual(withNoise,clean,"a match dated after the fixture's own kickoff must not change the result at all");
  assert.equal(withNoise.restDays.home,4);
});

test("E) существующие SCI clamps (5..95) продолжают работать после исправления referenceTime",()=>{
  const farFuture=scheduleCongestion({homeId:1,awayId:2,utcDate:"2026-10-20T20:00:00Z"},{finished:[matchAt(1,"2026-09-01T20:00:00Z"),matchAt(2,"2026-09-01T20:00:00Z")]});
  assert.equal(farFuture.home,5,"a very long rest must still clamp to the existing floor");
  assert.equal(farFuture.away,5);

  const sameDay=scheduleCongestion({homeId:1,awayId:2,utcDate:"2026-09-10T13:00:00Z"},{finished:[matchAt(1,"2026-09-10T12:00:00Z"),matchAt(2,"2026-09-10T12:00:00Z")]});
  assert.equal(sameDay.home,95,"a same-day rest must still clamp to the existing ceiling");
  assert.equal(sameDay.away,95);
});
