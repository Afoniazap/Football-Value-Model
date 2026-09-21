import { sameTeamIdentity } from "./teamAliases.js";

// Two independent matching paths, each with its own trust level and window.
//
// NAME path: team-name identity + kickoff proximity. A same-pair match can
// coincidentally exist at a very different date (a two-legged tie's other
// leg, the reverse home/away fixture from earlier/later in the season) —
// confirmed repeatedly in forensic audits — so this path stays tight: 12h.
//
// EXACT-ID path: same provider (API_FOOTBALL) reporting the same immutable
// fixtureId is a strictly stronger identity signal than name+time — it is
// the SAME real-world fixture regardless of how far its final kickoff drifted
// from the pre-match snapshot. Confirmed real gaps in our own provider cache
// (not hypothetical): Utrecht vs Go Ahead Eagles, fixtureId 1552155, status
// INT (interrupted) on 2026-09-05 -> FT (finished) on 2026-09-08, +3 days,
// same venue/referee; two PST(postponed)->FT reschedules at +7 days each;
// one PST->NS->FT reschedule at +15 days. 30 days is a deliberate ceiling —
// not "no limit" — comfortably covering every observed real case while still
// rejecting a coincidentally-reused ID paired with a wildly different date.
const NAME_MATCH_WINDOW_MS = 12 * 3600_000;
const EXACT_ID_MATCH_WINDOW_MS = 30 * 24 * 3600_000;
const EXACT_ID_SOURCE = "API_FOOTBALL";

// insertRow's own FINISHED filter (sqliteHistory.js) already keeps
// PST/INT/SUSP/ABD/CANC out of SQLite entirely — a row only ever reaches
// `history` once it has a final score. This check is deliberate
// defense-in-depth for the exact-ID path specifically: that path trusts a
// bare ID match far more than the name path does, so it must not lean on an
// upstream invariant alone.
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "FINISHED"]);

/**
 * Finds the single best history row for a prediction, shared by
 * predictionHistory.js, marketBetHistory.js and dualShadow.js so all three
 * grade with the same identity rules instead of three independently-drifting
 * copies. `prediction` needs `.kickoff` (or `.utcDate`), `.home`, `.away`,
 * `.fixtureId`; `history` rows come from sqliteHistory.js's `loadAllHistory`
 * (`.playedAt`, `.homeTeam.name`, `.awayTeam.name`, `.sourceFixtureId`,
 * `.provenance.source`/`.sources`, `.status`).
 */
export function matchHistoryRow(prediction, history) {
  const kickoff = prediction.kickoff || prediction.utcDate;
  const candidates = (history || []).filter(row => {
    const delta = Math.abs(new Date(row.playedAt) - new Date(kickoff));
    const finished = FINISHED_STATUSES.has(String(row.status || "FINISHED").toUpperCase());
    const sources = [row.provenance?.source, ...(row.provenance?.sources || [])];

    const exactId = finished &&
      sources.includes(EXACT_ID_SOURCE) &&
      String(row.sourceFixtureId || "") === String(prediction.fixtureId) &&
      delta <= EXACT_ID_MATCH_WINDOW_MS;

    const byName = sameTeamIdentity(row.homeTeam?.name, prediction.home) &&
      sameTeamIdentity(row.awayTeam?.name, prediction.away) &&
      delta <= NAME_MATCH_WINDOW_MS;

    return exactId || byName;
  });
  return candidates.sort((a, b) =>
    Math.abs(new Date(a.playedAt) - new Date(kickoff)) - Math.abs(new Date(b.playedAt) - new Date(kickoff))
  )[0] || null;
}
