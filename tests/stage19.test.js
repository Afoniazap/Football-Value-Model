import assert from "node:assert/strict";
import { outcomeProbabilities, poissonProbability, scoreMatrix } from "../src/model/challenger/poisson.js";
import { applyTemperature, fitTemperature } from "../src/model/challenger/calibration.js";

function testOutcomeProperties() {
  for (const [h, a] of [[0.25, 0.2], [1.5, 1.1], [3.2, 2.8], [0, 0]]) {
    const o = outcomeProbabilities(h, a);
    assert.ok(Math.abs(o.home + o.draw + o.away - 1) < 1e-12);
    assert.ok([o.home, o.draw, o.away].every(p => p >= 0 && p <= 1));
    const m = scoreMatrix(h, a);
    assert.ok(Math.abs(m.reduce((s, r) => s + r.probability, 0) - 1) < 1e-12);
    const swapped = outcomeProbabilities(a, h);
    assert.ok(Math.abs(o.home - swapped.away) < 1e-12);
    assert.ok(Math.abs(o.draw - swapped.draw) < 1e-12);
  }
  // monotonic: higher home lambda -> higher home win probability
  assert.ok(outcomeProbabilities(2, 1).home > outcomeProbabilities(1.5, 1).home);
  // truncation at maxGoals=8 stays negligible within clamp range (<1% mass)
  const tail = 1 - Array.from({ length: 9 }, (_, k) => poissonProbability(3.2, k)).reduce((a, b) => a + b, 0);
  assert.ok(tail < 0.01);
}

function testInvalidLambdaRejected() {
  for (const bad of [-1, NaN, Infinity, undefined]) {
    assert.throws(() => outcomeProbabilities(bad, 1), RangeError);
    assert.throws(() => outcomeProbabilities(1, bad), RangeError);
  }
}

function testCalibrationIdentityOnEmpty() {
  assert.deepEqual(fitTemperature([]), { temperature: 1, logLoss: null });
  const m = { home: 0.5, draw: 0.3, away: 0.2 };
  const same = applyTemperature(m, 1);
  assert.ok(Math.abs(same.home - 0.5) < 1e-12 && Math.abs(same.draw - 0.3) < 1e-12);
}

testOutcomeProperties();
testInvalidLambdaRejected();
testCalibrationIdentityOnEmpty();
console.log("Stage 19 tests OK: Poisson invariants, invalid lambda rejection, empty-sample calibration identity.");
