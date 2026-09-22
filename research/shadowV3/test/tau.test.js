import { test } from "node:test";
import assert from "node:assert/strict";
import { tau } from "../model.js";

test("tau is exactly 1 outside the 4 low-score cells, for any rho/lambda", () => {
  for (const [x, y] of [[2, 0], [0, 2], [2, 2], [3, 1], [1, 3], [5, 5]]) {
    assert.equal(tau(x, y, 1.7, 1.3, 0.08), 1);
    assert.equal(tau(x, y, 2.9, 0.4, -0.1), 1);
  }
});

test("tau matches the closed-form Dixon-Coles definition on all 4 special cells", () => {
  const lh = 1.4, la = 1.1, rho = 0.07;
  assert.equal(tau(0, 0, lh, la, rho), 1 - lh * la * rho);
  assert.equal(tau(0, 1, lh, la, rho), 1 + lh * rho);
  assert.equal(tau(1, 0, lh, la, rho), 1 + la * rho);
  assert.equal(tau(1, 1, lh, la, rho), 1 - rho);
});

test("the tau correction is exactly mass-preserving over the 4 cells, for any rho (algebraic identity, not truncation-dependent)", () => {
  const lh = 1.6, la = 1.2;
  for (const rho of [-0.2, -0.05, 0, 0.05, 0.15]) {
    // Poisson pmf at (0,0)/(0,1)/(1,0)/(1,1) -- k! is 1 for k=0,1 so no factorial needed here.
    const p00 = Math.exp(-lh) * Math.exp(-la);
    const p01 = Math.exp(-lh) * la * Math.exp(-la);
    const p10 = lh * Math.exp(-lh) * Math.exp(-la);
    const p11 = lh * Math.exp(-lh) * la * Math.exp(-la);
    const deltaMass =
      (tau(0, 0, lh, la, rho) - 1) * p00 +
      (tau(0, 1, lh, la, rho) - 1) * p01 +
      (tau(1, 0, lh, la, rho) - 1) * p10 +
      (tau(1, 1, lh, la, rho) - 1) * p11;
    assert.ok(Math.abs(deltaMass) < 1e-12, `rho=${rho} deltaMass=${deltaMass}`);
  }
});
