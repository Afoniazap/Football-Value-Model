import assert from "node:assert/strict";
import { regulationScore, toRegulationMatches } from "../src/providers/footballDataScore.js";
import { normalizeFinishedMatch } from "../src/historical/normalize.js";
import { settleSignal } from "../src/audit/settlement.js";
import { fetchFinishedResults } from "../src/providers/results/footballDataResults.js";
import { leagueGoalRates } from "../src/model/challenger/teamStrength.js";

// football-data v4 docs example: shoot-out match, fullTime includes penalties.
const shootout = {
  id: 1,
  status: "FINISHED",
  utcDate: "2026-04-01T19:00:00Z",
  homeTeam: { id: 10, name: "A" },
  awayTeam: { id: 20, name: "B" },
  score: {
    winner: "HOME_TEAM",
    duration: "PENALTY_SHOOTOUT",
    fullTime: { home: 7, away: 6 },
    regularTime: { home: 1, away: 1 },
    extraTime: { home: 0, away: 0 },
    penalties: { home: 6, away: 5 }
  }
};
const extraTime = {
  ...shootout,
  id: 2,
  score: {
    duration: "EXTRA_TIME",
    fullTime: { home: 3, away: 2 },
    regularTime: { home: 2, away: 2 },
    extraTime: { home: 1, away: 0 }
  }
};
const regular = { ...shootout, id: 3, score: { duration: "REGULAR", fullTime: { home: 2, away: 0 } } };
const noDuration = { ...shootout, id: 4, score: { fullTime: { home: 1, away: 3 } } };
const etWithoutRegular = { ...shootout, id: 5, score: { duration: "EXTRA_TIME", fullTime: { home: 2, away: 1 } } };
const nullScore = { ...shootout, id: 6, score: { duration: "REGULAR", fullTime: { home: null, away: null } } };

assert.deepEqual(regulationScore(shootout), { home: 1, away: 1, duration: "PENALTY_SHOOTOUT", basis: "REGULAR_TIME" });
assert.deepEqual(regulationScore(extraTime), { home: 2, away: 2, duration: "EXTRA_TIME", basis: "REGULAR_TIME" });
assert.deepEqual(regulationScore(regular), { home: 2, away: 0, duration: "REGULAR", basis: "FULL_TIME" });
assert.deepEqual(regulationScore(noDuration), { home: 1, away: 3, duration: "REGULAR", basis: "FULL_TIME" });
assert.equal(regulationScore(etWithoutRegular), null, "unknown 90-minute score must stay unavailable");
assert.equal(regulationScore(nullScore), null, "null goals must not become 0-0");

// Historical normalization: 90-minute result (draw), not the shoot-out aggregate.
const normalized = normalizeFinishedMatch(shootout);
assert.equal(normalized.homeGoals, 1);
assert.equal(normalized.awayGoals, 1);
assert.equal(normalized.result, "D");
assert.equal(normalizeFinishedMatch(nullScore), null);

// Model context: fullTime rewritten to regulation, original preserved, unknown dropped.
const ctx = toRegulationMatches([shootout, extraTime, regular, etWithoutRegular]);
assert.equal(ctx.adjusted, 2);
assert.equal(ctx.dropped, 1);
assert.equal(ctx.matches.length, 3);
assert.deepEqual(ctx.matches[0].score.fullTime, { home: 1, away: 1 });
assert.deepEqual(ctx.matches[0].score.fullTimeReported, { home: 7, away: 6 });
assert.equal(ctx.matches[2], regular, "regular-duration matches pass through unchanged");
// Before: league goal rates were inflated by penalty goals (7+3+2 home goals over 3).
const before = leagueGoalRates({ matches: [shootout, extraTime, regular] });
const after = leagueGoalRates({ matches: ctx.matches });
assert.equal(before.homeGoalsPerGame, 4);
assert.equal(after.homeGoalsPerGame, 5 / 3);

// Settlement: missing goals must not be graded (Number(null) === 0 would settle 0-0).
const drawSignal = { signalId: "s", fixtureId: "1", market: "h2h", selection: "X", officialOdds: 3.4 };
assert.equal(settleSignal(drawSignal, { homeGoals: null, awayGoals: null }), null);
const underSignal = { signalId: "u", fixtureId: "1", market: "totals", selection: "Under", line: 2.5, officialOdds: 1.9 };
assert.equal(settleSignal(underSignal, { homeGoals: null, awayGoals: null }), null);
// Shoot-out match: X bet wins on 90-minute 1-1, Under 2.5 wins (fullTime 7-6 would be LOSS for both).
assert.equal(settleSignal(drawSignal, { homeGoals: normalized.homeGoals, awayGoals: normalized.awayGoals }).status, "WIN");
assert.equal(settleSignal(underSignal, { homeGoals: normalized.homeGoals, awayGoals: normalized.awayGoals }).status, "WIN");

// Results provider (settlement input) uses 90-minute goals and skips unknowns.
const results = await fetchFinishedResults({
  request: async () => ({ matches: [shootout, etWithoutRegular, regular] }),
  token: "x"
});
assert.equal(results.data.length, 2);
assert.equal(results.data[0].homeGoals, 1);
assert.equal(results.data[0].awayGoals, 1);
assert.equal(results.data[0].result, "D");
assert.equal(results.data[0].duration, "PENALTY_SHOOTOUT");

console.log("Stage 19 tests OK: extra-time/penalty scores normalized to 90 minutes; null goals never settled.");
