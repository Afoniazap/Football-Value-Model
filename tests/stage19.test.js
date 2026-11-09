import assert from "node:assert/strict";
import { bestH2H } from "../src/market/oddsMatching.js";
import { outcomeProbabilities, scoreMatrix } from "../src/model/challenger/poisson.js";

const book = (title, h, d, a) => ({ title, markets: [{ key: "h2h", outcomes: [
  { name: "A", price: h }, { name: "Draw", price: d }, { name: "B", price: a }] }] });
const ev = bookmakers => ({ home_team: "A", away_team: "B", bookmakers });

// invalid prices (<=1, NaN, strings) must never be selected, even with the highest sum
assert.equal(bestH2H(ev([book("bad", 1, 50, 50)])), null);
assert.equal(bestH2H(ev([book("bad", 0.5, 50, 50)])), null);
assert.equal(bestH2H(ev([book("nan", "x", 3, 3)])), null);
assert.equal(bestH2H(ev([book("bad", 1, 99, 99), book("ok", 2, 3.4, 3.8)])).bookmaker, "ok");

// Poisson invariants
for (const [h, a] of [[0.25, 0.2], [1.4, 1.1], [3.2, 2.8]]) {
  const o = outcomeProbabilities(h, a);
  assert.ok(Math.abs(o.home + o.draw + o.away - 1) < 1e-12);
  assert.ok(Math.abs(scoreMatrix(h, a).reduce((s, r) => s + r.probability, 0) - 1) < 1e-12);
}
assert.ok(outcomeProbabilities(2, 1).home > outcomeProbabilities(1.5, 1).home);
console.log("Stage 19 tests OK: bestH2H rejects invalid prices, Poisson invariants.");
