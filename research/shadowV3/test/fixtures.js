// Shared synthetic dataset for Shadow V3 unit tests -- deliberately tiny and
// deterministic (no DB access). One league, 4 teams, 6 matches chosen so the
// scoreline set hits every Dixon-Coles tau special case: (0,0),(0,1),(1,0),(1,1)
// plus two "generic" high scores.
const DAY = 86400000;
const BASE = Date.UTC(2024, 0, 1);

export function makeSyntheticMatches() {
  return [
    { league: "T", home: "A", away: "B", kickoffMs: BASE + 0 * DAY, homeGoals: 0, awayGoals: 0 },
    { league: "T", home: "B", away: "A", kickoffMs: BASE + 1 * DAY, homeGoals: 0, awayGoals: 1 },
    { league: "T", home: "C", away: "D", kickoffMs: BASE + 2 * DAY, homeGoals: 1, awayGoals: 0 },
    { league: "T", home: "D", away: "C", kickoffMs: BASE + 3 * DAY, homeGoals: 1, awayGoals: 1 },
    { league: "T", home: "A", away: "C", kickoffMs: BASE + 4 * DAY, homeGoals: 2, awayGoals: 1 },
    { league: "T", home: "B", away: "D", kickoffMs: BASE + 5 * DAY, homeGoals: 3, awayGoals: 2 }
  ];
}

export function uniformWeights(matches) { return matches.map(() => 1); }
