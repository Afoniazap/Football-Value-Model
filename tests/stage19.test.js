import assert from "node:assert/strict";
import { outcomeProbabilities, scoreMatrix, poissonProbability } from "../src/model/challenger/poisson.js";
import { removeMargin } from "../src/market/margin.js";
import { applyTemperature } from "../src/model/challenger/calibration.js";
import { expectedGoalsFromContext } from "../src/model/challenger/teamStrength.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Poisson: normalisation over the clamp range of lambdas used by the challenger.
for (const lh of [0.25, 0.8, 1.4, 2.4, 3.2]) {
  for (const la of [0.2, 0.7, 1.1, 2.0, 2.8]) {
    const o = outcomeProbabilities(lh, la);
    near(o.home + o.draw + o.away, 1);
    near(scoreMatrix(lh, la).reduce((s, r) => s + r.probability, 0), 1);
    assert.ok(o.home >= 0 && o.draw >= 0 && o.away >= 0);
  }
}

// Truncation at 8 goals loses <1% single-side mass at the largest clamp lambda (0.57% measured).
let tail = 1;
for (let g = 0; g <= 8; g += 1) tail -= poissonProbability(3.2, g);
assert.ok(tail < 0.01, `tail mass ${tail}`);

// Symmetry and monotonicity.
const sym = outcomeProbabilities(1.3, 1.3);
near(sym.home, sym.away);
assert.ok(outcomeProbabilities(2.0, 1.0).home > outcomeProbabilities(1.5, 1.0).home);
assert.ok(outcomeProbabilities(1.5, 0.8).away < outcomeProbabilities(1.5, 1.2).away);

// Margin removal: sums to 1, preserves ordering, fair book is unchanged.
const nv = removeMargin({ home: 2, draw: 3.5, away: 4 });
near(nv.home + nv.draw + nv.away, 1);
assert.ok(nv.home > nv.draw && nv.draw > nv.away);
const fair = removeMargin({ home: 2, draw: 4, away: 4 });
near(fair.home, 0.5);

// Temperature: T=1 is identity, T>1 flattens, result sums to 1.
const m = { home: 0.6, draw: 0.25, away: 0.15 };
const t1 = applyTemperature(m, 1);
near(t1.home, m.home); near(t1.away, m.away);
const t2 = applyTemperature(m, 1.5);
near(t2.home + t2.draw + t2.away, 1);
assert.ok(t2.home < m.home && t2.away > m.away);

// Empty context falls back to bounded, finite lambdas.
const xg = expectedGoalsFromContext({}, { homeId: 1, awayId: 2 });
assert.ok(Number.isFinite(xg.lambdaHome) && xg.lambdaHome >= 0.25 && xg.lambdaHome <= 3.2);
assert.ok(Number.isFinite(xg.lambdaAway) && xg.lambdaAway >= 0.2 && xg.lambdaAway <= 2.8);

console.log("Stage 19 tests OK: Poisson normalisation/truncation/symmetry, margin removal, temperature, lambda bounds.");
