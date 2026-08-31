import test from "node:test";
import assert from "node:assert/strict";
import { asianSettlement, asianSettlementOutcome, evaluateMarkets } from "../src/engine/markets.js";

const outcomeCases = [
  [-0.75, [[2, 0, "WIN"], [1, 0, "HALF_WIN"], [0, 0, "LOSE"], [0, 1, "LOSE"]]],
  [-0.25, [[1, 0, "WIN"], [0, 0, "HALF_LOSS"], [0, 1, "LOSE"]]],
  [0.25, [[1, 0, "WIN"], [0, 0, "HALF_WIN"], [0, 1, "LOSE"]]],
  [0.75, [[1, 0, "WIN"], [0, 0, "WIN"], [0, 1, "HALF_LOSS"], [0, 2, "LOSE"]]]
];

for (const [line, cases] of outcomeCases) {
  test(`quarter-line AH ${line} preserves partial settlements`, () => {
    for (const [home, away, expected] of cases) {
      assert.equal(asianSettlementOutcome(home, away, "home", line), expected);
    }
  });
}

function oddsFor(line, homeOdds = 2.2, awayOdds = 2) {
  return { best: { h2h: {}, totals: {}, spreads: {
    [`Alpha|${line}`]: { name: "Alpha", point: line, odds: homeOdds, bookmaker: "Book" },
    [`Beta|${-line}`]: { name: "Beta", point: -line, odds: awayOdds, bookmaker: "Book" }
  } } };
}

function ahCandidate(matrix, line, odds = 2.2) {
  return evaluateMarkets(
    { home: "Alpha", away: "Beta" },
    { scoreMatrix: matrix },
    { probability: { home: 0.4, draw: 0.3, away: 0.3 } },
    oddsFor(line, odds)
  ).find(row => row.label.startsWith("Ф1"));
}

test("quarter-line AH EV, fair odds and edge use stake-weighted settlement", () => {
  const matrix = [
    { h: 2, a: 0, p: 0.2 },
    { h: 1, a: 0, p: 0.3 },
    { h: 0, a: 0, p: 0.2 },
    { h: 0, a: 1, p: 0.3 }
  ];
  const result = ahCandidate(matrix, -0.75);

  assert.deepEqual(result.settlement, { win: 0.2, halfWin: 0.3, push: 0, halfLoss: 0, lose: 0.5 });
  assert.ok(Math.abs(result.ev - (-8)) < 1e-10);
  assert.ok(Math.abs(result.fairOdds - (1 + 0.5 / 0.35)) < 1e-10);
  assert.ok(Math.abs(result.probability - (0.35 / 0.85)) < 1e-10);
  const marketFair = (1 / 2.2) / ((1 / 2.2) + (1 / 2));
  assert.ok(Math.abs(result.edge - ((0.35 / 0.85 - marketFair) * 100)) < 1e-10);
});

function legacySettlement(matrix, side, line) {
  let win = 0;
  let push = 0;
  let lose = 0;
  for (const score of matrix) {
    const diff = side === "home" ? score.h - score.a : score.a - score.h;
    const result = diff + line;
    if (result > 0) win += score.p;
    else if (result === 0) push += score.p;
    else lose += score.p;
  }
  return { win, push, lose };
}

test("integer and half-line AH remain identical to legacy calculation", () => {
  const matrix = [
    { h: 2, a: 0, p: 0.15 },
    { h: 1, a: 0, p: 0.25 },
    { h: 0, a: 0, p: 0.3 },
    { h: 0, a: 1, p: 0.2 },
    { h: 0, a: 2, p: 0.1 }
  ];
  for (const line of [-1, -0.5, 0, 0.5, 1]) {
    const legacy = legacySettlement(matrix, "home", line);
    const current = asianSettlement(matrix, "home", line);
    assert.deepEqual(current, { ...legacy, halfWin: 0, halfLoss: 0 });
    const result = ahCandidate(matrix, line);
    const effectiveProbability = legacy.win + legacy.push * 0.5;
    assert.ok(Math.abs(result.probability - effectiveProbability) < 1e-10);
    assert.ok(Math.abs(result.fairOdds - 1 / effectiveProbability) < 1e-10);
    assert.ok(Math.abs(result.ev - ((effectiveProbability * 2.2 - 1) * 100)) < 1e-10);
  }
});

test("non-AH market calculations retain exact formulas", () => {
  const matrix = [
    { h: 1, a: 0, p: 0.4 },
    { h: 0, a: 0, p: 0.3 },
    { h: 0, a: 1, p: 0.3 }
  ];
  const odds = { best: {
    h2h: { home: { odds: 2.4, bookmaker: "Book" }, draw: { odds: 3.2, bookmaker: "Book" }, away: { odds: 3.1, bookmaker: "Book" } },
    totals: { "Over|0.5": { name: "Over", point: 0.5, odds: 1.5, bookmaker: "Book" }, "Under|0.5": { name: "Under", point: 0.5, odds: 2.8, bookmaker: "Book" } },
    spreads: {}
  } };
  const results = evaluateMarkets(
    { home: "Alpha", away: "Beta" },
    { scoreMatrix: matrix },
    { probability: { home: 0.4, draw: 0.3, away: 0.3 } },
    odds
  );
  const home = results.find(row => row.label === "П1");
  const over = results.find(row => row.label === "ТБ 0.5");
  assert.equal(home.probability, 0.4);
  assert.ok(Math.abs(home.fairOdds - 2.5) < 1e-10);
  assert.ok(Math.abs(home.ev - (-4)) < 1e-10);
  assert.ok(Math.abs(over.probability - 0.7) < 1e-10);
  assert.ok(Math.abs(over.fairOdds - (1 / 0.7)) < 1e-10);
  assert.ok(Math.abs(over.ev - 5) < 1e-10);
});
