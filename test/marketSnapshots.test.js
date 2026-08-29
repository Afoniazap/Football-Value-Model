import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enforceMarketFreshness, resolveMarketSnapshot } from "../src/markets/marketSnapshots.js";

const fixture={id:"1",home:"Alpha",away:"Beta",utcDate:"2026-08-29T18:00:00Z"};
const market={source:"TEST",bookmakers:[{name:"Book"}],best:{h2h:{home:{odds:2}}}};

test("свежий market snapshot переживает outage как STALE с исходным timestamp",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-market-")),"snapshots.json"),start=Date.parse("2026-08-29T12:00:00Z");
  resolveMarketSnapshot({filePath:file,fixture,freshMarket:market,now:start});
  const stale=resolveMarketSnapshot({filePath:file,fixture,freshMarket:null,now:start+30*60_000});
  assert.equal(stale.freshness,"STALE");assert.equal(stale.marketData.source,"TEST");assert.equal(stale.fetchedAt,"2026-08-29T12:00:00.000Z");
});

test("истёкший snapshot не возвращает market data",()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"fvm-market-expired-")),"snapshots.json"),start=Date.parse("2026-08-29T10:00:00Z");
  resolveMarketSnapshot({filePath:file,fixture,freshMarket:market,now:start,staleMs:60*60_000});
  const expired=resolveMarketSnapshot({filePath:file,fixture,freshMarket:null,now:start+2*3600_000,staleMs:60*60_000});
  assert.equal(expired.freshness,"EXPIRED");assert.equal(expired.marketData,null);
});

test("STALE market не создаёт новый VALUE",()=>{
  const guarded=enforceMarketFreshness({category:"VALUE",reason:"ok"},"STALE");
  assert.equal(guarded.category,"WAIT");assert.match(guarded.reason,/STALE/);
});
