import test from "node:test";
import assert from "node:assert/strict";
import { dashboardText } from "../src/ui/telegram.js";

test("dashboard does not present provider failure as genuine zero fixtures",()=>{
  const text=dashboardText({
    loading:false,
    updatedAt:null,
    results:[],
    errors:["API-Football: DAILY LIMIT"],
    providers:{apiFootball:{dailyLimit:true,requests:1,cacheHits:0,staleHits:0,avoided:2}}
  });
  assert.match(text,/Матчей на 24 часа: <b>N\/A<\/b>/);
  assert.match(text,/API-Football: <b>DAILY LIMIT<\/b>/);
  assert.doesNotMatch(text,/Матчей на 24 часа: <b>0<\/b>/);
});
