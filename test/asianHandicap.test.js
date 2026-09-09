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
  return { bookmakers:[{name:"Benchmark",h2h:{},totals:[],spreads:[{name:"Alpha",point:line,odds:1.9},{name:"Beta",point:-line,odds:1.9}]}],best: { h2h: {}, totals: {}, spreads: {
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
  // `probability` is the literal full-win chance; the break-even-equivalent
  // Edge is derived from, is exposed separately (not misleadingly as "probability").
  assert.equal(result.probability, result.fullWinProbability);
  assert.equal(result.probability, 0.2);
  assert.ok(Math.abs(result.breakEvenProbability - (0.35 / 0.85)) < 1e-10);
  const marketFair = 0.5;
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

test("half-line AH remains identical to the legacy calculation (no push is possible)", () => {
  const matrix = [
    { h: 2, a: 0, p: 0.15 },
    { h: 1, a: 0, p: 0.25 },
    { h: 0, a: 0, p: 0.3 },
    { h: 0, a: 1, p: 0.2 },
    { h: 0, a: 2, p: 0.1 }
  ];
  for (const line of [-0.5, 0.5]) {
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

// Section 10/21 of the OU/Asian totals audit: integer AH lines (0, ±1, ±2...)
// carry real push probability exactly like integer totals, and had the same
// bug — routed through the plain binary path with a naive fairOdds ignoring
// push. Must use the same push-aware settlement math.
test("integer AH lines with real push mass use push-aware fair odds, not naive 1/probability", () => {
  const matrix = [
    { h: 2, a: 0, p: 0.15 },
    { h: 1, a: 0, p: 0.25 },
    { h: 0, a: 0, p: 0.3 },
    { h: 0, a: 1, p: 0.2 },
    { h: 0, a: 2, p: 0.1 }
  ];
  const expected = {
    "-1": { win: 0.15, push: 0.25, lose: 0.6, fairOdds: 5 },
    "0": { win: 0.4, push: 0.3, lose: 0.3, fairOdds: 1.75 },
    "1": { win: 0.7, push: 0.2, lose: 0.1, fairOdds: 8 / 7 }
  };
  for (const line of [-1, 0, 1]) {
    const legacy = legacySettlement(matrix, "home", line);
    assert.ok(Math.abs(legacy.win - expected[line].win) < 1e-10);
    assert.ok(Math.abs(legacy.push - expected[line].push) < 1e-10);
    assert.ok(Math.abs(legacy.lose - expected[line].lose) < 1e-10);
    const result = ahCandidate(matrix, line);
    assert.ok(result.settlement, "integer AH lines must now expose a full settlement distribution");
    assert.ok(Math.abs(result.pushProbability - expected[line].push) < 1e-10);
    assert.ok(Math.abs(result.fairOdds - expected[line].fairOdds) < 1e-10, `line ${line}`);
    const ev = (result.settlement.win * (result.fairOdds - 1) - result.settlement.lose) * 100;
    assert.ok(Math.abs(ev) < 1e-9, `EV(fairOdds) must be ~0 for line ${line}`);
    assert.equal(result.probability, result.fullWinProbability);
  }
});

test("non-AH market calculations retain exact formulas", () => {
  const matrix = [
    { h: 1, a: 0, p: 0.4 },
    { h: 0, a: 0, p: 0.3 },
    { h: 0, a: 1, p: 0.3 }
  ];
  const odds = { bookmakers:[{name:"Book",h2h:{home:2.4,draw:3.2,away:3.1},totals:[{name:"Over",point:.5,odds:1.5},{name:"Under",point:.5,odds:2.8}],spreads:[]}],best: {
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
