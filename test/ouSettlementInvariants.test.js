import test from "node:test";
import assert from "node:assert/strict";
import { buildScoreMatrix } from "../src/engine/utils.js";
import { totalsSettlement, totalsSettlementOutcome, isHalfLine, asianSettlementOutcome } from "../src/engine/markets.js";

const LINES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.25];
const LAMBDA_TOTALS = [
  [0.4, 0.4],   // ~0.8
  [0.8, 0.7],   // ~1.5
  [1.1, 0.9],   // ~2.0
  [1.3, 1.2],   // ~2.5
  [1.6, 1.4],   // ~3.0
  [1.9, 1.6],   // ~3.5
  [2.2, 1.8]    // ~4.0
];

// --- Invariant 1: score matrix mass sums to ~1 for every representative lambda pair. ---
test("invariant: sum(scoreMatrix probabilities) is always ~1", () => {
  for (const [lh, la] of LAMBDA_TOTALS) {
    const matrix = buildScoreMatrix(lh, la);
    const sum = matrix.reduce((s, x) => s + x.p, 0);
    assert.ok(Math.abs(1 - sum) < 1e-9, `lambda ${lh}/${la} sum=${sum}`);
    for (const cell of matrix) {
      assert.ok(Number.isFinite(cell.p), `lambda ${lh}/${la} produced a non-finite cell`);
      assert.ok(cell.p >= 0, `lambda ${lh}/${la} produced a negative probability`);
      assert.ok(cell.p <= 1, `lambda ${lh}/${la} produced probability >1`);
    }
  }
});

// --- Invariant 2: for a half line, P(over)+P(under) ~= 1 (no push is possible). ---
test("invariant: half-line totals are exactly complementary", () => {
  for (const [lh, la] of LAMBDA_TOTALS) {
    const matrix = buildScoreMatrix(lh, la);
    for (const line of LINES.filter(isHalfLine)) {
      const over = matrix.filter(x => x.h + x.a > line).reduce((s, x) => s + x.p, 0);
      const under = matrix.filter(x => x.h + x.a < line).reduce((s, x) => s + x.p, 0);
      assert.ok(Math.abs(over + under - 1) < 1e-9, `line ${line}, lambda ${lh}/${la}`);
    }
  }
});

// --- Invariant 3: every settlement distribution sums to ~1. ---
test("invariant: win+halfWin+push+halfLoss+lose ~= 1 for every line and side", () => {
  for (const [lh, la] of LAMBDA_TOTALS) {
    const matrix = buildScoreMatrix(lh, la);
    for (const line of LINES) {
      for (const side of ["over", "under"]) {
        const s = totalsSettlement(matrix, side, line);
        const sum = s.win + s.halfWin + s.push + s.halfLoss + s.lose;
        assert.ok(Math.abs(sum - 1) < 1e-9, `${side} ${line} lambda ${lh}/${la} sum=${sum}`);
        for (const key of Object.keys(s)) {
          assert.ok(Number.isFinite(s[key]) && s[key] >= -1e-12, `${side} ${line} ${key} not a valid probability`);
        }
      }
    }
  }
});

// --- Invariant 4: EV(fairOdds) ~= 0 for every line/side/lambda combination. ---
test("invariant: EV computed at the settlement's own fair odds is always ~0", () => {
  for (const [lh, la] of LAMBDA_TOTALS) {
    const matrix = buildScoreMatrix(lh, la);
    for (const line of LINES) {
      for (const side of ["over", "under"]) {
        const s = totalsSettlement(matrix, side, line);
        const winStake = s.win + s.halfWin * 0.5, lossStake = s.lose + s.halfLoss * 0.5;
        if (winStake <= 0) continue; // fairOdds is undefined (Infinity) — nothing to check
        const fairOdds = 1 + lossStake / winStake;
        const ev = s.win * (fairOdds - 1) + s.halfWin * (fairOdds - 1) / 2 - s.halfLoss * 0.5 - s.lose;
        assert.ok(Math.abs(ev) < 1e-9, `${side} ${line} lambda ${lh}/${la} EV(fair)=${ev}`);
      }
    }
  }
});

// --- Invariant 5: increasing the total line monotonically favours Under over Over. ---
test("invariant: raising the total line monotonically increases Under's win chance and decreases Over's", () => {
  for (const [lh, la] of LAMBDA_TOTALS) {
    const matrix = buildScoreMatrix(lh, la);
    let previousUnder = -Infinity, previousOver = Infinity;
    for (const line of LINES) {
      const under = totalsSettlement(matrix, "under", line).win;
      const over = totalsSettlement(matrix, "over", line).win;
      assert.ok(under >= previousUnder - 1e-12, `Under win% must not decrease as the line rises (line ${line})`);
      assert.ok(over <= previousOver + 1e-12, `Over win% must not increase as the line rises (line ${line})`);
      previousUnder = under; previousOver = over;
    }
  }
});

// --- Invariant 7 (renumbered from the task's list — no NaN/Infinity except the documented all-loss/all-win edge, no probability outside [0,1]). ---
test("invariant: no NaN and no unexpected Infinity across the full line matrix", () => {
  for (const [lh, la] of LAMBDA_TOTALS) {
    const matrix = buildScoreMatrix(lh, la);
    for (const line of LINES) {
      for (const side of ["over", "under"]) {
        const s = totalsSettlement(matrix, side, line);
        const winStake = s.win + s.halfWin * 0.5, lossStake = s.lose + s.halfLoss * 0.5;
        assert.ok(Number.isFinite(winStake) && Number.isFinite(lossStake));
        const fairOdds = winStake > 0 ? 1 + lossStake / winStake : Infinity;
        // Infinity is only mathematically correct when there is truly no
        // winning stake at all (winStake===0) — never a silent NaN.
        assert.ok(Number.isFinite(fairOdds) || winStake === 0, `unexpected non-finite fairOdds for ${side} ${line}`);
        assert.ok(!Number.isNaN(fairOdds));
      }
    }
  }
});

// --- Invariant 8: provider line values normalize identically regardless of string/number representation. ---
test("invariant: provider line parsing normalizes strings and numbers identically", () => {
  for (const raw of ["1.25", 1.25, "2.75", 2.75, "2", 2, "2.5", 2.5]) {
    const asNumber = Number(raw);
    assert.equal(isHalfLine(raw), isHalfLine(asNumber), `raw=${JSON.stringify(raw)}`);
    const matrix = buildScoreMatrix(1.4, 1.1);
    assert.deepEqual(totalsSettlement(matrix, "under", raw), totalsSettlement(matrix, "under", asNumber));
    assert.equal(totalsSettlementOutcome(2, "under", raw), totalsSettlementOutcome(2, "under", asNumber));
  }
});

// Confirmed bug (now fixed): asianSettlementOutcome used `diff + l` — a
// numeric add only if `l` really is a number. A string line ("1" instead of
// 1) triggered JS string concatenation instead, turning a genuine PUSH into
// a LOSE. totalsSettlementOutcome never had this specific defect (it only
// ever subtracts, which JS always coerces to numeric), but is covered too.
test("regression: a string-typed line must settle identically to the same numeric line (AH)", () => {
  const cases = [
    [0, 1, "home", "1", 1],   // diff=-1, must PUSH both ways
    [2, 0, "home", "1.5", 1.5],
    [1, 1, "away", "0.75", 0.75],
    [3, 1, "home", "2", 2]
  ];
  for (const [home, away, side, rawLine, numericLine] of cases) {
    assert.equal(asianSettlementOutcome(home, away, side, rawLine), asianSettlementOutcome(home, away, side, numericLine));
  }
});
test("regression: a string-typed line must settle identically to the same numeric line (totals)", () => {
  const cases = [[1, "under", "1"], [3, "over", "2.75"], [2, "under", "2"]];
  for (const [total, side, rawLine] of cases) {
    assert.equal(totalsSettlementOutcome(total, side, rawLine), totalsSettlementOutcome(total, side, Number(rawLine)));
  }
});

// --- Section 18: compact monotonic sanity table across representative lambdaTotals and common lines. ---
test("section 18 table: fairOdds moves the direction plausibility demands as lambdaTotal rises", () => {
  const line = 2.5; // half line, control group — pure monotonic P(over) vs lambdaTotal
  let previousOverFair = Infinity;
  for (const [lh, la] of LAMBDA_TOTALS) {
    const matrix = buildScoreMatrix(lh, la);
    const over = matrix.filter(x => x.h + x.a > line).reduce((s, x) => s + x.p, 0);
    const fairOdds = 1 / over;
    assert.ok(fairOdds <= previousOverFair + 1e-9, `Over ${line} fair odds must fall as lambdaTotal rises (lambda ${lh}/${la})`);
    previousOverFair = fairOdds;
  }
});
