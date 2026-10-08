import test from "node:test";
import assert from "node:assert/strict";
import { alignContextTeamIds } from "../src/engine/contextIds.js";

test("Football-Data context IDs align with API-Football fixture IDs by team name",()=>{
  const fixture={home:"Real Madrid",away:"Real Sociedad",homeId:541,awayId:548};
  const context={standings:{standings:[{type:"TOTAL",table:[{team:{id:86,name:"Real Madrid CF"}},{team:{id:92,name:"Real Sociedad"}}]}]},finished:[{homeTeam:{id:86,name:"Real Madrid CF"},awayTeam:{id:92,name:"Real Sociedad"}}]};
  const aligned=alignContextTeamIds(context,fixture);
  assert.deepEqual(aligned.standings.standings[0].table.map(row=>row.team.id),[541,548]);
  assert.equal(aligned.finished[0].homeTeam.id,541);
  assert.equal(aligned.finished[0].awayTeam.id,548);
});

test("unrelated teams retain their provider IDs",()=>{
  const context={standings:{standings:[{type:"TOTAL",table:[{team:{id:65,name:"Barcelona"}}]}]},finished:[]};
  const aligned=alignContextTeamIds(context,{home:"Real Madrid",away:"Real Sociedad",homeId:541,awayId:548});
  assert.equal(aligned.standings.standings[0].table[0].team.id,65);
});

test("provider club prefixes do not block a conservative Celta match",()=>{
  const context={standings:{standings:[{type:"TOTAL",table:[{team:{id:558,name:"RC Celta de Vigo"}},{team:{id:79,name:"CA Osasuna"}}]}]},finished:[]};
  const aligned=alignContextTeamIds(context,{home:"Celta Vigo",away:"Osasuna",homeId:538,awayId:727});
  assert.deepEqual(aligned.standings.standings[0].table.map(row=>row.team.id),[538,727]);
});

test("QPR resolves against the provider's full club name (0.000 similarity without the abbreviation expansion)",()=>{
  const context={standings:{standings:[{type:"TOTAL",table:[{team:{id:9,name:"Queens Park Rangers FC"}},{team:{id:8,name:"Middlesbrough FC"}}]}]},finished:[]};
  const aligned=alignContextTeamIds(context,{home:"QPR",away:"Middlesbrough",homeId:72,awayId:70});
  assert.deepEqual(aligned.standings.standings[0].table.map(row=>row.team.id),[72,70]);
});

test("Sheffield Utd resolves against the provider's \"United\" spelling (0.72 similarity, just under the 0.82 bar without the expansion)",()=>{
  const context={standings:{standings:[{type:"TOTAL",table:[{team:{id:6,name:"Sheffield United FC"}},{team:{id:5,name:"Norwich City FC"}}]}]},finished:[]};
  const aligned=alignContextTeamIds(context,{home:"Sheffield Utd",away:"Norwich",homeId:62,awayId:71});
  assert.deepEqual(aligned.standings.standings[0].table.map(row=>row.team.id),[62,71]);
});

test("the Utd/United expansion does not create false collisions with unrelated clubs sharing the word \"United\"",()=>{
  const context={standings:{standings:[{type:"TOTAL",table:[
    {team:{id:1,name:"Sheffield Wednesday FC"}},   // must NOT be pulled in by "Sheffield Utd"
    {team:{id:2,name:"Newcastle United FC"}}         // a different "United" club must NOT be pulled in either
  ]}]},finished:[]};
  const aligned=alignContextTeamIds(context,{home:"Sheffield Utd",away:"Aston Villa",homeId:62,awayId:2});
  const ids=aligned.standings.standings[0].table.map(row=>row.team.id);
  assert.deepEqual(ids,[1,2],"neither Sheffield Wednesday nor a different United club should have been reassigned to the fixture's ids");
});

// Previously documented as a known flaw: similarity()'s substring-inclusion shortcut
// treated "Queens Park Rangers" and the unrelated Scottish club "Queens Park" as one
// club. The strict matcher no longer accepts partial-name inclusion, so the provider ID
// of the unrelated club is retained.
test("QPR is no longer matched to the unrelated club \"Queens Park\" by partial name inclusion",()=>{
  const context={standings:{standings:[{type:"TOTAL",table:[{team:{id:3,name:"Queens Park FC"}}]}]},finished:[]};
  const aligned=alignContextTeamIds(context,{home:"QPR",away:"Middlesbrough",homeId:72,awayId:70});
  assert.equal(aligned.standings.standings[0].table[0].team.id,3);
});
