import test from "node:test";
import assert from "node:assert/strict";
import { classifyPair, dedupeLogicalMatchesV2, auditCorpus, groupLogicalMatches } from "./dedupeV2.js";

// Minimal, TEST-ONLY alias stub — intentionally NOT the production alias
// dataset (that lives in the user's own src/history/teamAliases.js and is
// never copied into this research branch). It only knows the handful of
// pairs these synthetic tests exercise.
const ALIAS_GROUPS = [
  ["psv", "psv eindhoven"],
  ["vitoria sc", "vitoria guimaraes"], // Portugal club, kept SEPARATE from Brazil's "Vitória" below
];
function canonicalTeamIdentity(name) {
  const key = String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  for (const group of ALIAS_GROUPS) if (group.includes(key)) return group[0];
  return key;
}
function sameTeamIdentity(a, b) {
  return canonicalTeamIdentity(a) === canonicalTeamIdentity(b);
}
const teamIdentity = { sameTeamIdentity, canonicalTeamIdentity };

function row({ recordKey, home, away, playedAt, hg = 2, ag = 1, code = "DED", season = "2026", source = "FOOTBALL_DATA" }) {
  return {
    recordKey, playedAt, homeTeam: { name: home }, awayTeam: { name: away },
    competition: { code, season }, score: { fullTime: { home: hg, away: ag } }, provenance: { source }
  };
}

test("same real match, two spellings, kickoff drift under 24h -> DUPLICATE", () => {
  const a = row({ recordKey: "FD:1", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z" });
  const b = row({ recordKey: "AF:1", home: "PSV Eindhoven", away: "Ajax", playedAt: "2026-08-02T19:00:00Z", source: "API_FOOTBALL" });
  const verdict = classifyPair(a, b, { teamIdentity });
  assert.equal(verdict.verdict, "DUPLICATE");
});

test("reversed home/away is never a duplicate even same day", () => {
  const a = row({ recordKey: "1", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z" });
  const b = row({ recordKey: "2", home: "Ajax", away: "PSV", playedAt: "2026-08-02T20:00:00Z" });
  assert.equal(classifyPair(a, b, { teamIdentity }).verdict, "DIFFERENT");
});

test("genuine rematch a month later in the same competition/season is not a duplicate", () => {
  const a = row({ recordKey: "1", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z", hg: 2, ag: 1 });
  const b = row({ recordKey: "2", home: "PSV", away: "Ajax", playedAt: "2026-09-02T18:45:00Z", hg: 1, ag: 1 });
  assert.equal(classifyPair(a, b, { teamIdentity }).verdict, "DIFFERENT");
});

test("youth side is never merged with the senior side despite identical base name", () => {
  const a = row({ recordKey: "1", home: "Liverpool", away: "Chelsea", playedAt: "2026-08-02T18:45:00Z" });
  const b = row({ recordKey: "2", home: "Liverpool U18", away: "Chelsea U18", playedAt: "2026-08-02T18:45:00Z" });
  const verdict = classifyPair(a, b, { teamIdentity });
  assert.equal(verdict.verdict, "DIFFERENT");
  assert.match(verdict.reasons.join(" "), /tier/);
});

test("women's side is never merged with the men's side", () => {
  const a = row({ recordKey: "1", home: "Arsenal", away: "Spurs", playedAt: "2026-08-02T18:45:00Z" });
  const b = row({ recordKey: "2", home: "Arsenal Women", away: "Spurs Women", playedAt: "2026-08-02T18:45:00Z" });
  assert.equal(classifyPair(a, b, { teamIdentity }).verdict, "DIFFERENT");
});

test("reserve/B team is never merged with the first team", () => {
  const a = row({ recordKey: "1", home: "Real Madrid", away: "Barcelona", playedAt: "2026-08-02T18:45:00Z" });
  const b = row({ recordKey: "2", home: "Real Madrid Castilla", away: "Barcelona", playedAt: "2026-08-02T18:45:00Z" });
  assert.equal(classifyPair(a, b, { teamIdentity }).verdict, "DIFFERENT");
});

test("Vitoria SC (Portugal) is never merged with Vitoria (Brazil), same day coincidence", () => {
  const a = row({ recordKey: "1", home: "Vitoria SC", away: "Benfica", playedAt: "2026-08-02T18:45:00Z", code: "PPL" });
  const b = row({ recordKey: "2", home: "Vitoria", away: "Flamengo", playedAt: "2026-08-02T20:00:00Z", code: "BSA" });
  assert.equal(classifyPair(a, b, { teamIdentity }).verdict, "DIFFERENT");
});

test("postponement drift beyond 24h, same competition+season, identical score -> DUPLICATE (the gap the production 24h-only window misses)", () => {
  const a = row({ recordKey: "FD:9", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z", hg: 2, ag: 2 });
  const b = row({ recordKey: "AF:9", home: "PSV Eindhoven", away: "Ajax", playedAt: "2026-08-09T18:45:00Z", hg: 2, ag: 2, source: "API_FOOTBALL" }); // +7 days
  const verdict = classifyPair(a, b, { teamIdentity });
  assert.equal(verdict.verdict, "DUPLICATE");
  assert.match(verdict.reasons.join(" "), /wide window/);
});

test("same pair/day but conflicting final score is AMBIGUOUS, never auto-merged", () => {
  const a = row({ recordKey: "1", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z", hg: 2, ag: 1 });
  const b = row({ recordKey: "2", home: "PSV Eindhoven", away: "Ajax", playedAt: "2026-08-02T18:50:00Z", hg: 1, ag: 1, source: "API_FOOTBALL" });
  assert.equal(classifyPair(a, b, { teamIdentity }).verdict, "AMBIGUOUS");
});

test("same pair/day but different declared competition is AMBIGUOUS, never auto-merged", () => {
  const a = row({ recordKey: "1", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z", code: "DED" });
  const b = row({ recordKey: "2", home: "PSV Eindhoven", away: "Ajax", playedAt: "2026-08-02T18:50:00Z", code: "KNVB_CUP" });
  assert.equal(classifyPair(a, b, { teamIdentity }).verdict, "AMBIGUOUS");
});

test("dedupeLogicalMatchesV2 collapses a 6-matches-twice corpus to 6, same as production behaviour", () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const at = new Date(Date.parse("2026-08-02T18:45:00Z") + i * 7 * 86400_000);
    rows.push(row({ recordKey: `FD:${i}`, home: "PSV", away: `Opp${i}`, playedAt: at.toISOString() }));
    rows.push(row({ recordKey: `AF:${i}`, home: "PSV Eindhoven", away: `Opp${i}`, playedAt: new Date(at.getTime() + 15 * 60_000).toISOString(), source: "API_FOOTBALL" }));
  }
  assert.equal(dedupeLogicalMatchesV2(rows, { teamIdentity }).length, 6);
});

test("idempotency: re-running the grouping on an already-deduped set makes no further merges", () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const at = new Date(Date.parse("2026-08-02T18:45:00Z") + i * 7 * 86400_000);
    rows.push(row({ recordKey: `FD:${i}`, home: "PSV", away: `Opp${i}`, playedAt: at.toISOString() }));
    rows.push(row({ recordKey: `AF:${i}`, home: "PSV Eindhoven", away: `Opp${i}`, playedAt: new Date(at.getTime() + 15 * 60_000).toISOString(), source: "API_FOOTBALL" }));
  }
  const once = dedupeLogicalMatchesV2(rows, { teamIdentity });
  const report = auditCorpus(once, { teamIdentity });
  assert.equal(report.duplicateGroups.length, 0, "no new merges on a second pass");
  assert.equal(report.ambiguousGroups.length, 0);
});

test("auditCorpus reports group size and evidence for a confirmed duplicate, without mutating input", () => {
  const rows = [
    row({ recordKey: "FD:1", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:45:00Z" }),
    row({ recordKey: "AF:1", home: "PSV Eindhoven", away: "Ajax", playedAt: "2026-08-02T19:00:00Z", source: "API_FOOTBALL" })
  ];
  const before = JSON.stringify(rows);
  const report = auditCorpus(rows, { teamIdentity });
  assert.equal(JSON.stringify(rows), before, "input rows are never mutated");
  assert.equal(report.duplicateGroups.length, 1);
  assert.equal(report.duplicateGroups[0].size, 2);
  assert.equal(report.duplicateRowsRemoved, 1);
});

test("clique requirement: a row ambiguous against ONE cluster member blocks the whole merge, not just that pair", () => {
  // a1/a2 are a clean duplicate pair; b conflicts on score with a2 only.
  // b must NOT silently join the {a1,a2} cluster just because it agreed with a1.
  const a1 = row({ recordKey: "1", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:40:00Z", hg: 2, ag: 1 });
  const a2 = row({ recordKey: "2", home: "PSV", away: "Ajax", playedAt: "2026-08-02T18:50:00Z", hg: 2, ag: 1 });
  const b = row({ recordKey: "3", home: "PSV", away: "Ajax", playedAt: "2026-08-02T19:00:00Z", hg: 3, ag: 1 });
  const { clusters, ambiguousPairs } = groupLogicalMatches([a1, a2, b], { teamIdentity });
  const merged = clusters.find(c => c.rows.length > 1);
  assert.ok(merged, "a1/a2 still merge with each other");
  assert.equal(merged.rows.length, 2);
  assert.ok(ambiguousPairs.length >= 1, "b is flagged ambiguous rather than silently joining or silently dropped");
});
