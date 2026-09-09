import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMarkets, totalsSettlement, totalsSettlementOutcome } from "../src/engine/markets.js";

const outcomeCases = [
  ["under", 1.25, [[0, "WIN"], [1, "HALF_WIN"], [2, "LOSE"]]],
  ["over", 1.25, [[0, "LOSE"], [1, "HALF_LOSS"], [2, "WIN"]]],
  ["under", 2.25, [[1, "WIN"], [2, "HALF_WIN"], [3, "LOSE"]]],
  ["over", 2.25, [[1, "LOSE"], [2, "HALF_LOSS"], [3, "WIN"]]],
  ["under", 2.75, [[2, "WIN"], [3, "HALF_LOSS"], [4, "LOSE"]]],
  ["over", 2.75, [[2, "LOSE"], [3, "HALF_WIN"], [4, "WIN"]]],
  ["under", 3.25, [[2, "WIN"], [3, "HALF_WIN"], [4, "LOSE"]]],
  ["over", 3.25, [[2, "LOSE"], [3, "HALF_LOSS"], [4, "WIN"]]]
];

for (const [side, line, cases] of outcomeCases) {
  test(`${side.toUpperCase()} ${line} preserves quarter-line settlement`, () => {
    for (const [goals, expected] of cases) {
      assert.equal(totalsSettlementOutcome(goals, side, line), expected);
    }
  });
}

function totalsOdds(line, overOdds, underOdds) {
  return { bookmakers:[{name:"Benchmark",h2h:{},spreads:[],totals:[{name:"Over",point:line,odds:1.9},{name:"Under",point:line,odds:1.9}]}],best: { h2h: {}, spreads: {}, totals: {
    [`Over|${line}`]: { name: "Over", point: line, odds: overOdds, bookmaker: "Book" },
    [`Under|${line}`]: { name: "Under", point: line, odds: underOdds, bookmaker: "Book" }
  } } };
}

function candidates(matrix, line, overOdds, underOdds) {
  return evaluateMarkets(
    { home: "Alpha", away: "Beta" },
    { scoreMatrix: matrix },
    { probability: { home: 0.4, draw: 0.3, away: 0.3 } },
    totalsOdds(line, overOdds, underOdds)
  ).filter(row => row.market === "OU");
}

test("quarter-line totals use stake-weighted EV, fair odds and edge", () => {
  const matrix = [
    { h: 0, a: 0, p: 0.3 },
    { h: 1, a: 0, p: 0.4 },
    { h: 1, a: 1, p: 0.3 }
  ];
  const rows = candidates(matrix, 1.25, 3, 1.8);
  const under = rows.find(row => row.label.endsWith("1.25") && row.settlement.halfWin > 0);
  const over = rows.find(row => row.label.endsWith("1.25") && row.settlement.halfLoss > 0);

  assert.deepEqual(under.settlement, { win: 0.3, halfWin: 0.4, push: 0, halfLoss: 0, lose: 0.3 });
  assert.deepEqual(over.settlement, { win: 0.3, halfWin: 0, push: 0, halfLoss: 0.4, lose: 0.3 });
  // `probability` is the literal chance of a clean win — NOT the break-even
  // figure previously (and misleadingly) exposed under that name.
  assert.equal(under.probability, under.fullWinProbability);
  assert.equal(under.probability, 0.3);
  assert.equal(over.probability, 0.3);
  // Edge/fairOdds still derive from the break-even-equivalent quantity, kept
  // available explicitly as `breakEvenProbability` for anyone who needs it.
  assert.ok(Math.abs(under.breakEvenProbability - 0.625) < 1e-10);
  assert.ok(Math.abs(under.fairOdds - 1.6) < 1e-10);
  assert.ok(Math.abs(under.ev - 10) < 1e-10);
  assert.ok(Math.abs(over.breakEvenProbability - 0.375) < 1e-10);
  assert.ok(Math.abs(over.fairOdds - (8 / 3)) < 1e-10);
  assert.ok(Math.abs(over.ev - 10) < 1e-10);
  assert.ok(Math.abs(under.breakEvenProbability + over.breakEvenProbability - 1) < 1e-10);
  assert.ok(Math.abs(under.edge + over.edge) < 1e-10);
});

test("quarter-line totals EV sign agrees with fair odds", () => {
  const matrix = [
    { h: 0, a: 0, p: 0.3 },
    { h: 1, a: 0, p: 0.4 },
    { h: 1, a: 1, p: 0.3 }
  ];
  for (const side of ["over", "under"]) {
    const settlement = totalsSettlement(matrix, side, 1.25);
    const winStake = settlement.win + settlement.halfWin * 0.5;
    const lossStake = settlement.lose + settlement.halfLoss * 0.5;
    const fair = 1 + lossStake / winStake;
    for (const [delta, expectedSign] of [[0.01, 1], [0, 0], [-0.01, -1]]) {
      const overOdds = side === "over" ? fair + delta : 2;
      const underOdds = side === "under" ? fair + delta : 2;
      const row = candidates(matrix, 1.25, overOdds, underOdds)
        .find(candidate => side === "over" ? candidate.settlement.halfLoss > 0 : candidate.settlement.halfWin > 0);
      if (expectedSign === 0) assert.ok(Math.abs(row.ev) < 1e-10);
      else assert.equal(Math.sign(row.ev), expectedSign);
    }
  }
});

test("half-line totals retain the plain binary calculation (no push is possible)", () => {
  const matrix = [
    { h: 0, a: 0, p: 0.1 },
    { h: 1, a: 0, p: 0.2 },
    { h: 1, a: 1, p: 0.3 },
    { h: 2, a: 1, p: 0.25 },
    { h: 2, a: 2, p: 0.15 }
  ];
  for (const line of [1.5, 2.5]) {
    const rows = candidates(matrix, line, 2.2, 2.2);
    for (const [side, predicate] of [["over", goals => goals > line], ["under", goals => goals < line]]) {
      const probability = matrix.filter(score => predicate(score.h + score.a)).reduce((sum, score) => sum + score.p, 0);
      const row = rows.find(candidate => side === "over" ? candidate.label.startsWith("ТБ") : candidate.label.startsWith("ТМ"));
      assert.equal(row.probability, probability);
      assert.equal(row.fairOdds, 1 / probability);
      assert.ok(Math.abs(row.ev - ((probability * 2.2 - 1) * 100)) < 1e-10);
      assert.equal(row.settlement, undefined);
    }
  }
});

// Section 10 of the OU/Asian totals audit: integer lines (1.0, 2.0, 3.0...)
// carry real push probability and were previously priced with the same
// plain-binary path as half lines, using a naive fairOdds=1/P(win) that
// silently ignores the push mass — this systematically mispriced fair odds
// (confirmed: 2.877 vs the mathematically correct 2.100 for one reproduced
// case). They must go through the same push-aware settlement math as quarter
// lines, per fairOdds = 1 + P(lose)/P(win).
test("integer totals with real push mass use push-aware fair odds, not naive 1/probability", () => {
  const matrix = [
    { h: 0, a: 0, p: 0.1 },
    { h: 1, a: 0, p: 0.2 },
    { h: 1, a: 1, p: 0.3 },
    { h: 2, a: 1, p: 0.25 },
    { h: 2, a: 2, p: 0.15 }
  ];
  const expected = {
    1: { overFair: 8 / 7, underFair: 8, overPush: 0.2, underPush: 0.2 },
    2: { overFair: 1.75, underFair: 7 / 3, overPush: 0.3, underPush: 0.3 },
    3: { overFair: 5, underFair: 1.25, overPush: 0.25, underPush: 0.25 }
  };
  for (const line of [1, 2, 3]) {
    const rows = candidates(matrix, line, 2.2, 2.2);
    const over = rows.find(row => row.label.startsWith("ТБ"));
    const under = rows.find(row => row.label.startsWith("ТМ"));
    assert.ok(over.settlement, "integer lines must now expose a full settlement distribution");
    assert.equal(over.pushProbability, expected[line].overPush);
    assert.equal(under.pushProbability, expected[line].underPush);
    assert.ok(Math.abs(over.fairOdds - expected[line].overFair) < 1e-10, `line ${line} over`);
    assert.ok(Math.abs(under.fairOdds - expected[line].underFair) < 1e-10, `line ${line} under`);
    // fairOdds plugged back into EV must return (approximately) zero — proves
    // the price is genuinely break-even, not just "a plausible-looking number".
    for (const row of [over, under]) {
      const ev = (row.settlement.win * (row.fairOdds - 1) - row.settlement.lose) * 100;
      assert.ok(Math.abs(ev) < 1e-9, `EV(fairOdds) must be ~0 for line ${line}`);
    }
    // `probability` stays the literal full-win chance, exactly as for quarter
    // lines and 1X2 — never the break-even-equivalent.
    assert.equal(over.probability, over.fullWinProbability);
    assert.equal(under.probability, under.fullWinProbability);
  }
});
