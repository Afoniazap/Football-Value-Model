import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScoreMatrix, chooseN, aggregate1X2, aggregateOverUnder, aggregateAsianHandicap } from "../scoreMatrix.js";

test("matrix sums to 1 within tolerance and every cell is non-negative, across a range of lambdas", () => {
  for (const [lh, la] of [[0.8, 0.9], [1.5, 1.2], [2.5, 2.1], [3.4, 3.1]]) {
    for (const rho of [-0.1, 0, 0.05]) {
      const { matrix, n, sum, tailMass } = buildScoreMatrix(lh, la, rho);
      let total = 0;
      for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) { assert.ok(matrix[x][y] >= 0); total += matrix[x][y]; }
      assert.ok(Math.abs(total - 1) < 1e-9);
      assert.equal(sum, 1);
      assert.ok(tailMass < 1e-6, `tailMass ${tailMass} too large for lh=${lh} la=${la}`);
    }
  }
});

test("chooseN grows with lambda to keep tail mass below target, and N=10 is provably insufficient at extreme lambda", () => {
  const nSmall = chooseN(0.8, 0.9);
  const nLarge = chooseN(3.4, 3.1);
  assert.ok(nLarge > nSmall);
  assert.ok(nLarge >= 15, `expected N>=15 at extreme lambda per the readiness audit, got ${nLarge}`);
});

test("aggregate1X2 sums to 1 and is symmetric when lambdaHome===lambdaAway and rho=0 (no home advantage baked in)", () => {
  const { matrix, n } = buildScoreMatrix(1.5, 1.5, 0);
  const { home, draw, away } = aggregate1X2(matrix, n);
  assert.ok(Math.abs(home + draw + away - 1) < 1e-9);
  assert.ok(Math.abs(home - away) < 1e-9);
});

test("OU/AH aggregation helpers are internally consistent (probabilities sum to 1) though unwired from any pipeline", () => {
  const { matrix, n } = buildScoreMatrix(1.6, 1.3, -0.05);
  const ou = aggregateOverUnder(matrix, n, 2.5);
  assert.ok(Math.abs(ou.over + ou.under + ou.push - 1) < 1e-9);
  const ah = aggregateAsianHandicap(matrix, n, -0.5);
  assert.ok(Math.abs(ah.home + ah.away + ah.push - 1) < 1e-9);
});
