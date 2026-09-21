import test from "node:test";
import assert from "node:assert/strict";
import { completedUtcDates, recentRefetchDates } from "../src/history/harvestDates.js";

test("daily harvest догоняет все пропущенные UTC-дни после restart",()=>{
  assert.deepEqual(
    completedUtcDates(Date.parse("2026-08-31T09:00:00Z"),3),
    ["2026-08-28","2026-08-29","2026-08-30"]
  );
});

test("daily harvest корректно проходит границу месяца",()=>{
  assert.deepEqual(
    completedUtcDates(Date.parse("2026-09-01T01:00:00Z"),2),
    ["2026-08-30","2026-08-31"]
  );
});

test("recentRefetchDates выбирает только N самых недавних дат из окна",()=>{
  const dates=completedUtcDates(Date.parse("2026-09-21T09:00:00Z"),3); // ["2026-09-18","2026-09-19","2026-09-20"]
  const recent=recentRefetchDates(dates,2);
  assert.deepEqual([...recent].sort(),["2026-09-19","2026-09-20"]);
  assert.ok(!recent.has("2026-09-18"),"the oldest date in the lookback window must keep the fast hasSourceDate skip");
});

test("recentRefetchDates(0) не форсирует ни одну дату — обратная совместимость с прежним поведением",()=>{
  const dates=completedUtcDates(Date.parse("2026-09-21T09:00:00Z"),3);
  assert.equal(recentRefetchDates(dates,0).size,0);
});

test("recentRefetchDates безопасен, когда окно короче recentDays",()=>{
  const dates=completedUtcDates(Date.parse("2026-09-21T09:00:00Z"),1); // ["2026-09-20"]
  assert.deepEqual([...recentRefetchDates(dates,2)],["2026-09-20"]);
});
