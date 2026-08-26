import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOddsApiIoMarkets } from "../src/connectors/oddsApiIo.js";
import { extractMarkets } from "../src/connectors/odds.js";

function response(data){return {ok:true,json:async()=>data};}

test("odds-api.io maps a conservatively matched fixture into FVM markets",async()=>{
  const calls=[];
  const request=async url=>{
    calls.push(url.pathname);
    if(url.pathname.endsWith("/events"))return response([{id:10,home:"Marseille",away:"Strasbourg",date:"2026-08-26T18:00:00Z"}]);
    return response([{eventId:10,bookmakers:{"bet365":[{name:"1x2",odds:[{home:1.9,draw:3.5,away:4.2}]}]}}]);
  };
  const result=await getOddsApiIoMarkets({apiKey:"secret",bookmakers:"bet365",fixtures:[{id:"f1",competitionCode:"FL1",home:"Marseille",away:"Strasbourg",utcDate:"2026-08-26T18:00:00Z"}],cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-odds-")),request});
  assert.equal(result.status,"OK");
  assert.deepEqual(calls,["/v3/events","/v3/odds/multi"]);
  const market=extractMarkets(result.byFixtureId.f1);
  assert.equal(market.best.h2h.home.odds,1.9);
  assert.equal(market.best.h2h.draw.odds,3.5);
  assert.equal(market.best.h2h.away.odds,4.2);
});

test("odds-api.io does not attach an event with reversed teams",async()=>{
  const request=async url=>response(url.pathname.endsWith("/events")?[{id:10,home:"Strasbourg",away:"Marseille",date:"2026-08-26T18:00:00Z"}]:[]);
  const result=await getOddsApiIoMarkets({apiKey:"secret",fixtures:[{id:"f1",competitionCode:"FL1",home:"Marseille",away:"Strasbourg",utcDate:"2026-08-26T18:00:00Z"}],cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-odds-")),request});
  assert.equal(result.matched,0);
  assert.deepEqual(result.byFixtureId,{});
});
