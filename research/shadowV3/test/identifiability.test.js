import { test } from "node:test";
import assert from "node:assert/strict";
import { buildParamIndex, initParams, reproject, teamKey } from "../params.js";
import { matchLambdas } from "../model.js";
import { makeSyntheticMatches } from "./fixtures.js";

test("reproject pins mean(attack) to 0 per league", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  for (let i = 0; i < params.attack.length; i++) { params.attack[i] = i * 1.7 - 3; params.defence[i] = -i * 0.4; }
  reproject(params, index);
  const teamIdxs = index.teams.map((t, i) => i).filter(i => index.teams[i].startsWith("T|"));
  const mean = teamIdxs.reduce((s, i) => s + params.attack[i], 0) / teamIdxs.length;
  assert.ok(Math.abs(mean) < 1e-9);
});

test("reproject's shift (attack_i+c, defence_i+c) leaves every lambda unchanged", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  for (let i = 0; i < params.attack.length; i++) { params.attack[i] = Math.sin(i) * 2; params.defence[i] = Math.cos(i) * 2; }
  const before = matches.map(m => matchLambdas(params, index, m));
  reproject(params, index);
  const after = matches.map(m => matchLambdas(params, index, m));
  for (let i = 0; i < matches.length; i++) {
    assert.ok(Math.abs(before[i].lambdaHome - after[i].lambdaHome) < 1e-9);
    assert.ok(Math.abs(before[i].lambdaAway - after[i].lambdaAway) < 1e-9);
  }
});

test("a non-null-space perturbation (attack only, no defence) DOES change lambda", () => {
  const matches = makeSyntheticMatches();
  const index = buildParamIndex(matches);
  const params = initParams(index);
  const before = matchLambdas(params, index, matches[0]);
  const i = index.teamIndex.get(teamKey("T", "A"));
  params.attack[i] += 1;
  const after = matchLambdas(params, index, matches[0]);
  assert.notEqual(before.lambdaHome, after.lambdaHome);
});
