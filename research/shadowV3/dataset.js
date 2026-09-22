// Shadow V3 research dataset builder -- STRICTLY READ-ONLY against the
// production SQLite file. Never imported by src/. Restricted to the 5
// leagues with genuine walk-forward depth (see the readiness audit):
// PD, PL, SA, FL1, BL1.
import { openHistoryDatabase } from "../../src/history/sqliteHistory.js";
import { canonicalTeamIdentity } from "../../src/history/teamAliases.js";

export const V3_LEAGUES = ["PD", "PL", "SA", "FL1", "BL1"];
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "FINISHED"]);

/**
 * Loads every eligible match for the 5 tracked leagues, sorted by kickoff.
 * Eligibility (all required, per spec): FINISHED status, competitionCode is
 * one of V3_LEAGUES (NULL/global-fallback rows excluded entirely in Phase
 * 1), a valid integer homeGoals/awayGoals, and a parseable kickoff.
 */
export function loadV3Dataset(dbPath) {
  const db = openHistoryDatabase(dbPath);
  const placeholders = V3_LEAGUES.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT identityKey, competitionCode, season, kickoff,
      homeTeamNormalized, awayTeamNormalized, homeGoals, awayGoals, status
    FROM matches
    WHERE competitionCode IN (${placeholders})
    ORDER BY kickoff ASC
  `).all(...V3_LEAGUES);
  db.close();

  const matches = [];
  for (const r of rows) {
    if (!FINISHED_STATUSES.has(String(r.status || "").toUpperCase())) continue;
    if (!Number.isInteger(r.homeGoals) || !Number.isInteger(r.awayGoals)) continue;
    if (r.homeGoals < 0 || r.awayGoals < 0) continue;
    const kickoffMs = Date.parse(r.kickoff);
    if (!Number.isFinite(kickoffMs)) continue;
    if (!r.homeTeamNormalized || !r.awayTeamNormalized) continue;
    // Resolve through the shared identity layer (src/history/teamAliases.js),
    // not the raw stored column: insertRow() writes canonicalTeamName(raw)
    // without alias resolution, so the SAME club can be stored under two
    // different literal strings across import batches/providers (e.g.
    // "angers sco" vs "angers", "como 1907" vs "como") -- see the Phase 1
    // identity forensic audit. canonicalTeamIdentity collapses known-alias
    // spellings to one key; unknown/genuinely new teams pass through unchanged.
    matches.push({
      identityKey: r.identityKey,
      league: r.competitionCode,
      season: r.season,
      kickoffMs,
      kickoff: r.kickoff,
      home: canonicalTeamIdentity(r.homeTeamNormalized),
      away: canonicalTeamIdentity(r.awayTeamNormalized),
      homeGoals: r.homeGoals,
      awayGoals: r.awayGoals
    });
  }
  return matches;
}

/** Strictly-before-cutoff filter -- the ONLY leakage guard training ever gets. */
export function beforeCutoff(matches, cutoffMs) {
  return matches.filter(m => m.kickoffMs < cutoffMs);
}
export function betweenCutoffs(matches, fromMs, toMs) {
  return matches.filter(m => m.kickoffMs >= fromMs && m.kickoffMs < toMs);
}

/** Per-league/season/team diagnostics -- printed by run.js, not asserted by tests. */
export function datasetDiagnostics(matches) {
  const byLeagueSeason = new Map();
  for (const m of matches) {
    const key = `${m.league}|${m.season}`;
    if (!byLeagueSeason.has(key)) byLeagueSeason.set(key, { league: m.league, season: m.season, matches: 0, teams: new Set(), minKickoff: m.kickoff, maxKickoff: m.kickoff });
    const g = byLeagueSeason.get(key);
    g.matches++; g.teams.add(m.home); g.teams.add(m.away);
    if (m.kickoff < g.minKickoff) g.minKickoff = m.kickoff;
    if (m.kickoff > g.maxKickoff) g.maxKickoff = m.kickoff;
  }
  return [...byLeagueSeason.values()].map(g => ({ league: g.league, season: g.season, matches: g.matches, teams: g.teams.size, minKickoff: g.minKickoff, maxKickoff: g.maxKickoff }));
}
