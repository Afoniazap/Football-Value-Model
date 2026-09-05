import { getCompetitionSeasonMatches } from "./sqliteHistory.js";

/**
 * Backfills one competition's previous season into local SQLite, at most once
 * per competition ever (not once per fixture, not once per refresh): a cheap
 * local COUNT is checked first, and the network fetcher only runs when that
 * comes back empty. `fetchSeason`/`importMatches` are injected so callers can
 * cache-first against the real SQLite DB and reuse the real connector without
 * this module importing them directly (keeps this file trivially testable).
 */
export async function ensurePreviousSeasonHistory(db, competitionCode, currentSeasonStart, { fetchSeason, importMatches }) {
  const currentYear = Number(currentSeasonStart);
  if (!competitionCode || !Number.isFinite(currentYear)) return { fetched: false, reason: "MISSING_INPUT" };

  const previousSeasonStart = String(currentYear - 1);
  const already = getCompetitionSeasonMatches(db, competitionCode, previousSeasonStart).length;
  if (already) return { fetched: false, reason: "ALREADY_PRESENT", previousSeasonStart, matches: already };

  try {
    const matches = await fetchSeason(competitionCode, previousSeasonStart);
    const added = importMatches(matches);
    return { fetched: true, reason: "OK", previousSeasonStart, requested: matches.length, added };
  } catch (error) {
    return { fetched: false, reason: error?.code || error?.message || "ERROR", previousSeasonStart };
  }
}
