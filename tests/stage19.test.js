import assert from "node:assert/strict";
import { calculateRisk, marketSpread, modelAgreement } from "../src/risk/riskScore.js";
import { outcomeProbabilities, scoreMatrix } from "../src/model/challenger/poisson.js";
import { removeMargin } from "../src/market/margin.js";

const book = (title, home, draw, away, order = ["A", "Draw", "B"]) => {
  const price = { A: home, Draw: draw, B: away };
  return { title, markets: [{ key: "h2h", outcomes: order.map(name => ({ name, price: price[name] })) }] };
};
const event = (...bookmakers) => ({ home_team: "A", away_team: "B", bookmakers });
const lineups = { data: { lineups: [{}, {}] } };

// --- Market spread: compares the same outcome across bookmakers only ---
const close = event(book("X", 1.5, 4.2, 6.5), book("Y", 1.52, 4.1, 6.4));
assert.ok(Math.abs(marketSpread(close) - 0.1) < 1e-9, "favourite vs underdog must not count as disagreement");
assert.ok(!calculateRisk({ item: {}, oddsEvent: close, apiFootballResult: lineups }).redFlags.some(f => f.code === "MARKET_DISAGREEMENT"));
// Outcome order differs between books: still matched by name.
const reordered = event(book("X", 1.5, 4.2, 6.5), book("Y", 1.52, 4.1, 6.4, ["B", "A", "Draw"]));
assert.ok(Math.abs(marketSpread(reordered) - 0.1) < 1e-9);
// Real disagreement on one outcome is still flagged.
const apart = event(book("X", 2.1, 3.4, 3.6), book("Y", 2.15, 3.4, 5.4));
assert.ok(Math.abs(marketSpread(apart) - 1.8) < 1e-9);
const apartRisk = calculateRisk({ item: {}, oddsEvent: apart, apiFootballResult: lineups });
assert.ok(apartRisk.redFlags.some(f => f.code === "MARKET_DISAGREEMENT"));
assert.equal(apartRisk.score, 94);
assert.equal(marketSpread(event(book("X", 1.5, 4.2, 6.5))), 0);
assert.equal(marketSpread(null), 0);

// --- Model agreement: sign-aware ---
const components = (formH, formA) => ({ components: { ppgH: 2, ppgA: 1, gdH: 1, gdA: 0, formH, formA } });
const sameDirection = modelAgreement(components(0.8, 0.4));
const opposite = modelAgreement(components(0.2, 0.9));
assert.ok(opposite < sameDirection, `opposite-direction signals (${opposite}) must agree less than same-direction (${sameDirection})`);
assert.equal(opposite, 0);
assert.equal(modelAgreement({ components: { ppgH: 1.5, ppgA: 1.5, gdH: 0, gdA: 0, formH: 0.5, formA: 0.5 } }), 100);
// Exact alignment of magnitudes and direction -> full agreement.
assert.equal(modelAgreement({ components: { ppgH: 2, ppgA: 1, gdH: 0, gdA: 0, formH: 0.8666666666666667, formA: 0 } }), 100);
assert.equal(modelAgreement(null), 100);

// --- Poisson property checks ---
for (const [lh, la] of [[0.25, 0.2], [1.35, 1.1], [2.4, 0.6], [3.2, 2.8]]) {
  const p = outcomeProbabilities(lh, la);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-12);
  const total = scoreMatrix(lh, la).reduce((s, r) => s + r.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  for (const v of [p.home, p.draw, p.away]) assert.ok(v > 0 && v < 1);
}
// Symmetry and monotonicity.
const sym = outcomeProbabilities(1.3, 1.3);
assert.ok(Math.abs(sym.home - sym.away) < 1e-12);
let prevHome = 0;
for (let lh = 0.4; lh <= 3.2; lh += 0.2) {
  const p = outcomeProbabilities(lh, 1.1);
  assert.ok(p.home > prevHome);
  prevHome = p.home;
}
// Truncation at 8 goals loses ~0.57% mass at the lambda clamp ceiling (3.2); matrix is renormalized.
const lost = 1 - [...Array(9).keys()].reduce((s, k) => s + Math.exp(-3.2) * 3.2 ** k / [1, 1, 2, 6, 24, 120, 720, 5040, 40320][k], 0);
assert.ok(lost < 0.006);
// Known reference value: P(draw) for lambda 1/1 = e^-2 * I0(2) ~= 0.3085.
assert.ok(Math.abs(outcomeProbabilities(1, 1).draw - 0.3085) < 0.001);

// --- Margin removal ---
const fair = removeMargin({ home: 1.9, draw: 3.5, away: 4.2 });
assert.ok(Math.abs(fair.home + fair.draw + fair.away - 1) < 1e-12);
assert.ok(fair.home > fair.draw && fair.draw > fair.away);

console.log("Stage 19 tests OK: risk market spread per outcome, sign-aware model agreement, Poisson/margin properties.");
