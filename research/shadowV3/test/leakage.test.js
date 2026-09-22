import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeCutoff, betweenCutoffs } from "../dataset.js";
import { decayWeight } from "../decay.js";
import { makeSyntheticMatches } from "./fixtures.js";

test("beforeCutoff never returns a match at or after the cutoff", () => {
  const matches = makeSyntheticMatches();
  const cutoff = matches[3].kickoffMs;
  const result = beforeCutoff(matches, cutoff);
  assert.ok(result.every(m => m.kickoffMs < cutoff));
  assert.equal(result.length, 3);
});

test("betweenCutoffs excludes the upper bound and includes the lower bound", () => {
  const matches = makeSyntheticMatches();
  const result = betweenCutoffs(matches, matches[1].kickoffMs, matches[4].kickoffMs);
  assert.deepEqual(result.map(m => m.kickoffMs), matches.slice(1, 4).map(m => m.kickoffMs));
});

test("decayWeight throws when the match is not strictly before the cutoff (hard leakage guard)", () => {
  const cutoff = Date.UTC(2024, 0, 1);
  assert.throws(() => decayWeight(cutoff, cutoff, 90), /leakage guard/);
  assert.throws(() => decayWeight(cutoff + 1000, cutoff, 90), /leakage guard/);
  assert.doesNotThrow(() => decayWeight(cutoff - 1000, cutoff, 90));
});
