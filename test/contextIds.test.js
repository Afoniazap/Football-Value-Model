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
