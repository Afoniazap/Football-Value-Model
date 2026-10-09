import { canonicalTeamIdentity } from "./teamAliases.js";

// One real match can be stored/delivered several times (providers differ in club spelling and
// kickoff by minutes). Two rows are the SAME logical match when:
//   1. both clubs have the same identity (alias-aware) and kickoffs are < 24h apart, or
//   2. one club has the same identity on the same side, the final score is identical and the
//      kickoffs are < 12h apart and the other club's names look like spellings of one club (share a
//      word / one contains the other) -- e.g. "Willem II" / "Willem II Tilburg" with no alias yet.
// A different score on the same club/time is NOT merged: it is a data conflict to surface, not hide.
export const SAME_MATCH_WINDOW_MS = 24 * 3600_000;
export const ONE_SIDE_WINDOW_MS = 12 * 3600_000;

export function matchSignature(row) {
  const when = row.playedAt || row.utcDate;
  const home = row.score?.fullTime?.home, away = row.score?.fullTime?.away;
  return {
    time: new Date(when).getTime(),
    home: canonicalTeamIdentity(row.homeTeam?.name),
    away: canonicalTeamIdentity(row.awayTeam?.name),
    score: Number.isFinite(Number(home)) && Number.isFinite(Number(away)) && home !== null && away !== null ? `${home}:${away}` : null
  };
}

// Two spellings of ONE club share a word ("Willem II" / "Willem II Tilburg", "Heerenveen" /
// "SC Heerenveen") or one contains the other; unrelated clubs do not. Guards rule 2 so that two
// different opponents of the same club are never merged just because of identical score/time.
function mayBeSpellingsOfOneClub(a, b) {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = new Set(a.split(" ").filter(word => word.length >= 4));
  return b.split(" ").some(word => word.length >= 4 && words.has(word));
}

export function isSameLogicalMatch(a, b) {
  const delta = Math.abs(a.time - b.time);
  if (!Number.isFinite(delta)) return false;
  if (a.home === b.home && a.away === b.away && delta < SAME_MATCH_WINDOW_MS) return true;
  if (!a.score || a.score !== b.score || delta >= ONE_SIDE_WINDOW_MS) return false;
  return (a.home === b.home && mayBeSpellingsOfOneClub(a.away, b.away)) ||
    (a.away === b.away && mayBeSpellingsOfOneClub(a.home, b.home));
}

// Keeps the first row of every logical match, scanning `rows` in the given (priority) order.
export function keepFirstOfEachLogicalMatch(rows) {
  const kept = [];
  for (const row of rows) {
    const signature = matchSignature(row);
    if (kept.some(other => isSameLogicalMatch(other.signature, signature))) continue;
    kept.push({ row, signature });
  }
  return kept.map(entry => entry.row);
}

// Groups of rows that describe the same logical match (diagnostic).
export function groupLogicalDuplicates(rows) {
  const groups = [];
  for (const row of rows) {
    const signature = matchSignature(row);
    const group = groups.find(candidate => candidate.signatures.some(other => isSameLogicalMatch(other, signature)));
    if (group) { group.rows.push(row); group.signatures.push(signature); } else groups.push({ rows: [row], signatures: [signature] });
  }
  return groups.filter(group => group.rows.length > 1).map(group => group.rows);
}
