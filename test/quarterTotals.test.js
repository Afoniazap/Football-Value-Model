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
  return { best: { h2h: {}, spreads: {}, totals: {
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
  assert.ok(Math.abs(under.probability - 0.625) < 1e-10);
  assert.ok(Math.abs(under.fairOdds - 1.6) < 1e-10);
  assert.ok(Math.abs(under.ev - 10) < 1e-10);
  assert.ok(Math.abs(over.probability - 0.375) < 1e-10);
  assert.ok(Math.abs(over.fairOdds - (8 / 3)) < 1e-10);
  assert.ok(Math.abs(over.ev - 10) < 1e-10);
  assert.ok(Math.abs(under.probability + over.probability - 1) < 1e-10);
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

test("integer and half-line totals retain legacy binary calculation", () => {
  const matrix = [
    { h: 0, a: 0, p: 0.1 },
    { h: 1, a: 0, p: 0.2 },
    { h: 1, a: 1, p: 0.3 },
    { h: 2, a: 1, p: 0.25 },
    { h: 2, a: 2, p: 0.15 }
  ];
  for (const line of [1, 1.5, 2, 2.5, 3]) {
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
