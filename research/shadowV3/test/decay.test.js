import { test } from "node:test";
import assert from "node:assert/strict";
import { decayWeight, HALF_LIFE_CANDIDATES } from "../decay.js";

test("weight is exactly 0.5 at exactly one half-life of age", () => {
  const cutoff = Date.UTC(2024, 6, 1);
  for (const halfLife of HALF_LIFE_CANDIDATES) {
    const kickoff = cutoff - halfLife * 86400000;
    assert.ok(Math.abs(decayWeight(kickoff, cutoff, halfLife) - 0.5) < 1e-9);
  }
});

test("weight approaches 1.0 as age approaches zero, and decreases monotonically with age", () => {
  const cutoff = Date.UTC(2024, 6, 1);
  const wAlmostZero = decayWeight(cutoff - 1, cutoff, 90);
  assert.ok(wAlmostZero > 0.999999);
  const w1 = decayWeight(cutoff - 10 * 86400000, cutoff, 90);
  const w2 = decayWeight(cutoff - 20 * 86400000, cutoff, 90);
  assert.ok(w1 > w2);
  assert.ok(w1 < 1);
});
