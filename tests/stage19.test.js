import assert from "node:assert/strict";
import { outcomeProbabilities, poissonProbability } from "../src/model/challenger/poisson.js";
import { gradeOverUnder, gradeAsianHandicap, fixedStakeProfitLoss } from "../src/audit/settlement.js";

function testPoissonProperties() {
  for (const [h, a] of [[0.25, 0.2], [1.2, 1.2], [3.2, 0.2], [3.2, 2.8], [0.5, 2.8]]) {
    const p = outcomeProbabilities(h, a);
    assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-12);
    assert.ok(p.draw > 0.05, `draw floor lambda=${h}/${a}`);
    const mass = p.scoreMatrix.reduce((s, r) => s + r.probability, 0);
    assert.ok(Math.abs(mass - 1) < 1e-12);
  }
  const mid = outcomeProbabilities(1.4, 1.1);
  assert.ok(outcomeProbabilities(2.0, 1.1).home > mid.home, "home prob monotone in lambdaHome");
  assert.ok(outcomeProbabilities(1.4, 1.6).away > mid.away, "away prob monotone in lambdaAway");
  const untruncated = Array.from({ length: 9 }, (_, g) => poissonProbability(1.4, g)).reduce((s, v) => s + v, 0);
  assert.ok(untruncated > 0.999, "maxGoals=8 truncation loses <0.1% at lambda=1.4");
}

function testQuarterLineGrading() {
  const ou = (selection, line, h, a) => gradeOverUnder({ selection, line, homeGoals: h, awayGoals: a });
  assert.equal(ou("over", 2.5, 2, 1), "WIN");
  assert.equal(ou("under", 2.5, 2, 1), "LOSS");
  assert.equal(ou("over", 2.0, 1, 1), "PUSH");
  assert.equal(ou("over", 2.25, 1, 1), "HALF_LOSS");
  assert.equal(ou("under", 2.25, 1, 1), "HALF_WIN");
  assert.equal(ou("over", 2.75, 2, 1), "HALF_WIN");
  assert.equal(ou("under", 2.75, 2, 1), "HALF_LOSS");
  const ah = (selection, line, h, a) => gradeAsianHandicap({ selection, line, homeGoals: h, awayGoals: a });
  assert.equal(ah("home", -0.25, 1, 1), "HALF_LOSS");
  assert.equal(ah("away", 0.25, 1, 1), "HALF_WIN");
  assert.equal(ah("home", -0.75, 1, 0), "HALF_WIN");
  assert.equal(ah("home", 0, 1, 1), "PUSH");
  assert.equal(fixedStakeProfitLoss("HALF_WIN", 2).netUnits, 0.5);
  assert.equal(fixedStakeProfitLoss("HALF_LOSS", 2).netUnits, -0.5);
}

testPoissonProperties();
testQuarterLineGrading();
console.log("Stage 19 tests OK: Poisson properties and quarter-line settlement grading.");
