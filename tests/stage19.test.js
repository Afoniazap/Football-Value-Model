import assert from "node:assert/strict";
import { leagueGoalRates } from "../src/model/challenger/teamStrength.js";
import { formLambdaFactors } from "../src/model/challenger/formAdjustment.js";
import { buildModel } from "../src/model/probability.js";

const m = (id, h, a, hg, ag, d) => ({
  id, utcDate: d, homeTeam: { id: h }, awayTeam: { id: a },
  score: { fullTime: { home: hg, away: ag } }
});

// Unplayed / score-less matches must not be treated as 0-0 results.
const played = [m(1, 1, 2, 3, 1, "2026-01-01T15:00:00Z"), m(2, 2, 1, 1, 1, "2026-01-08T15:00:00Z")];
const withUnplayed = [...played, m(3, 1, 2, null, null, "2026-01-15T15:00:00Z"), m(4, 2, 1, undefined, undefined, "2026-01-16T15:00:00Z")];
assert.deepEqual(leagueGoalRates({ matches: withUnplayed }), leagueGoalRates({ matches: played }));

const f = { homeId: 1, awayId: 2 };
assert.deepEqual(formLambdaFactors({ matches: withUnplayed }, f), formLambdaFactors({ matches: played }, f));

// Production form: unplayed matches must not count toward the >=3 games requirement or points.
const table = [1, 2].map(id => ({ team: { id }, playedGames: 10, points: 15, goalDifference: 0, goalsFor: 12, goalsAgainst: 12 }));
const ctx = ms => ({ standings: { standings: [{ type: "TOTAL", table }] }, matches: ms });
const two = [m(1, 1, 2, 1, 0, "2026-01-01T15:00:00Z"), m(2, 2, 1, 0, 0, "2026-01-08T15:00:00Z"),
  m(5, 1, 2, null, null, "2026-01-15T15:00:00Z")];
assert.equal(buildModel({ homeId: 1, awayId: 2 }, ctx(two)).model, null);
console.log("stage19 OK");
