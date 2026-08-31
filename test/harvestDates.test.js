import test from "node:test";
import assert from "node:assert/strict";
import { completedUtcDates } from "../src/history/harvestDates.js";

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
