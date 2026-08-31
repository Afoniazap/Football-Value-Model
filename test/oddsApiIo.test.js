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
  assert.equal(result.byFixtureId.f1.matchConfidence,1);
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

test("odds-api.io falls back to public sport discovery when a league slug is unavailable",async()=>{
  const calls=[];
  const request=async url=>{
    calls.push(url.searchParams.has("league")?"league":"sport");
    if(calls.length===1)return {ok:false,status:404,text:async()=>'{"error":"League not found"}'};
    if(url.pathname.endsWith("/events"))return response([{id:20,home:"Celje",away:"Slovan Bratislava",date:"2026-08-26T19:00:00Z"}]);
    return response([{eventId:20,bookmakers:{b:[{name:"1x2",odds:[{home:2,draw:3,away:4}]}]}}]);
  };
  const result=await getOddsApiIoMarkets({apiKey:"secret",fixtures:[{id:"f2",competitionCode:"CL",home:"Celje",away:"Slovan Bratislava",utcDate:"2026-08-26T19:00:00Z"}],cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-odds-")),request});
  assert.deepEqual(calls.slice(0,2),["league","sport"]);
  assert.equal(result.matched,1);
});

test("odds-api.io sends Europa League fixtures through the supported discovery cascade",async()=>{
  const leagues=[];
  const request=async url=>{
    if(url.pathname.endsWith("/events")){
      leagues.push(url.searchParams.get("league"));
      return response([{id:30,home:"Salzburg",away:"Mjallby",date:"2026-08-27T18:00:00Z"}]);
    }
    return response([{eventId:30,bookmakers:{b:[{name:"1x2",odds:[{home:1.5,draw:4,away:6}]}]}}]);
  };
  const result=await getOddsApiIoMarkets({apiKey:"secret",fixtures:[{id:"el1",competitionCode:"EL",home:"Salzburg",away:"Mjallby",utcDate:"2026-08-27T18:00:00Z"}],cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-odds-el-")),request});
  assert.deepEqual(leagues,["uefa-europa-league"]);
  assert.equal(result.matched,1);
});

test("unmapped competitions share one cached public football discovery batch",async()=>{
  const calls=[];
  const request=async url=>{
    calls.push(`${url.pathname}|${url.searchParams.get("league")||"PUBLIC"}`);
    if(url.pathname.endsWith("/events"))return response([
      {id:40,home:"Middlesbrough",away:"West Bromwich Albion",date:"2026-08-29T11:30:00Z"},
      {id:41,home:"AZ Alkmaar",away:"Go Ahead Eagles",date:"2026-08-29T18:00:00Z"}
    ]);
    return response([
      {eventId:40,bookmakers:{b:[{name:"1x2",odds:[{home:2,draw:3,away:4}]}]}},
      {eventId:41,bookmakers:{b:[{name:"1x2",odds:[{home:1.8,draw:3.6,away:4.5}]}]}}
    ]);
  };
  const fixtures=[
    {id:"sud",competitionCode:"SUD",home:"Middlesbrough FC",away:"West Bromwich Albion FC",utcDate:"2026-08-29T11:30:00Z"},
    {id:"leagues",competitionCode:"LEAGUES",home:"AZ",away:"Go Ahead Eagles",utcDate:"2026-08-29T18:00:00Z"}
  ];
  const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),"fvm-odds-public-"));
  const first=await getOddsApiIoMarkets({apiKey:"secret",fixtures,cacheDir,request});
  const second=await getOddsApiIoMarkets({apiKey:"secret",fixtures,cacheDir,request});
  assert.equal(first.matched,2);assert.equal(first.requests,2);
  assert.equal(first.perFixture.sud.discovery,"PUBLIC");assert.equal(first.perFixture.sud.reason,"QUOTE_FOUND");
  assert.equal(second.matched,2);assert.equal(second.requests,0);assert.equal(second.cacheHits,2);
  assert.equal(calls.length,2);
});

test("per-fixture diagnostics distinguish missing event from missing odds",async()=>{
  const request=async url=>url.pathname.endsWith("/events")
    ?response([{id:50,home:"Levante",away:"Real Betis",date:"2026-08-29T18:00:00Z"}])
    :response([]);
  const result=await getOddsApiIoMarkets({apiKey:"secret",fixtures:[
    {id:"matched",competitionCode:"PD",home:"Levante UD",away:"Real Betis Balompié",utcDate:"2026-08-29T18:00:00Z"},
    {id:"missing",competitionCode:"PD",home:"Other",away:"Teams",utcDate:"2026-08-29T20:00:00Z"}
  ],cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-odds-reasons-")),request});
  assert.equal(result.perFixture.matched.reason,"ODDS_NOT_RETURNED");
  assert.equal(result.perFixture.missing.reason,"EVENT_NOT_FOUND");
});

test("odds-api.io uses verified league slugs for added competition mappings",async t=>{
  const mappings={
    ELC:"england-championship",
    DED:"netherlands-eredivisie",
    PPL:"portugal-liga-portugal",
    BSA:"brazil-brasileiro-serie-a",
    BSB:"brazil-brasileiro-serie-b",
    MLS:"usa-mls"
  };
  for(const [competitionCode,expectedSlug] of Object.entries(mappings))await t.test(competitionCode,async()=>{
    const leagues=[];
    const request=async url=>{
      if(url.pathname.endsWith("/events")){leagues.push(url.searchParams.get("league"));return response([]);}
      return response([]);
    };
    await getOddsApiIoMarkets({apiKey:"secret",fixtures:[{id:competitionCode,competitionCode,home:"Home",away:"Away",utcDate:"2026-09-01T18:00:00Z"}],cacheDir:fs.mkdtempSync(path.join(os.tmpdir(),"fvm-odds-mapping-")),request});
    assert.deepEqual(leagues,[expectedSlug]);
  });
});
