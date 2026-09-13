// Pure helpers extracted from app.js's refresh() loop so the two confirmed
// provenance/diagnostic bugs (Mirassol-Vitória forensic audit) are directly
// unit-testable without mocking the whole refresh pipeline. Neither function
// touches teamStrengthModel, consensus, markets, FDS, Confidence, DQ,
// Stability, or any VALUE gate/threshold — diagnostic labeling only.

/**
 * Decides which provider ACTUALLY supplied the competition context, given
 * the already-resolved (not promise) results of both calls. Deliberately
 * does not look at whether an exception occurred: getApiFootballCompetitionContext
 * can resolve to null without throwing (e.g. a free-plan season restriction),
 * in which case "no exception" would wrongly imply API-Football was the
 * source even though the Football-Data fallback below it is what's actually
 * used. Confirmed root cause of a Football-Data-sourced standings table
 * being recorded (and appended to local history) with provenance API_FOOTBALL.
 */
export function resolveContextProvenance(apiFootballContext, footballDataContext) {
  if (apiFootballContext) return { context: apiFootballContext, source: "API_FOOTBALL" };
  if (footballDataContext) return { context: footballDataContext, source: "FOOTBALL_DATA" };
  return { context: null, source: null };
}

/**
 * Builds the same contextDiagnostic.status/source and `baseline` sub-object
 * app.js's refresh() loop assembles per fixture, given resolveTeamStrengthBaseline's
 * own output. FALLBACK_TWO_TEAM must describe what teamStrengthModel actually
 * consumed, not merely "local history would also have qualified":
 * mergeWithLocalHistory only falls through to its own two-team standings
 * when `baseContext.standings` was itself falsy (`context?.standings ||
 * local.standings`) — so the two-team table is the real source only when
 * baseContext had no standings of its own yet. Previously this checked only
 * `mergedContext.standings` truthiness, which stays true even when a live
 * (e.g. Football-Data) table is what's actually kept — mislabeling a real
 * competition-wide table as the two-team fallback (confirmed: Mirassol-Vitória).
 */
export function describeTeamStrengthSource({
  competitionBaseline, rawBaseline, baseContext, mergedContext,
  rawContext, rawContextSource, fallbackContextDiagnostic
}) {
  const localMeta = mergedContext.localHistoryMeta;
  const liveOrBaselineStandingsUsed = Boolean(baseContext.standings);
  const hasLocalModelContext = !competitionBaseline && !liveOrBaselineStandingsUsed &&
    Boolean(mergedContext.standings && localMeta?.homeMatches >= 4 && localMeta?.awayMatches >= 4);

  const contextDiagnosticBase = competitionBaseline
    ? { status: "OK", source: "COMPETITION_BASELINE", finished: mergedContext.finished.length, temporalSafe: true }
    : hasLocalModelContext
      ? { status: "OK", source: "LOCAL_HISTORY", finished: mergedContext.finished.length, provenance: localMeta.provenance, temporalSafe: true }
      : fallbackContextDiagnostic || { status: "UNAVAILABLE", reason: "NO_CONTEXT_MAPPING" };

  const rawTotalTeams = rawContext.standings
    ? (rawContext.standings.standings?.find(s => s.type === "TOTAL")?.table || []).length
    : 0;
  const baselineDiagnostic = competitionBaseline
    ? {
      baselineSource: competitionBaseline.baselineSource, baselineSample: competitionBaseline.baselineSample,
      baselineTeams: competitionBaseline.baselineTeams, sampleCurrentSeason: rawBaseline.sampleCurrentSeason,
      samplePreviousSeason: rawBaseline.samplePreviousSeason, sampleTotal: rawBaseline.sampleCurrentSeason + rawBaseline.samplePreviousSeason,
      competitionCoverage: competitionBaseline.baselineTeams, historySource: competitionBaseline.baselineSource,
      freshness: competitionBaseline.baselineSource === "CURRENT_SEASON" ? "CURRENT" : "STALE_PREVIOUS_SEASON"
    }
    : hasLocalModelContext
      ? {
        baselineSource: "FALLBACK_TWO_TEAM", baselineSample: (localMeta?.homeMatches || 0) + (localMeta?.awayMatches || 0),
        baselineTeams: 2, sampleCurrentSeason: rawBaseline?.sampleCurrentSeason || 0, samplePreviousSeason: rawBaseline?.samplePreviousSeason || 0,
        sampleTotal: (localMeta?.homeMatches || 0) + (localMeta?.awayMatches || 0), competitionCoverage: 2,
        historySource: "LOCAL_HISTORY", freshness: "FALLBACK"
      }
      : {
        baselineSource: rawContext.standings ? (rawContextSource || "LIVE_API") : "NONE", baselineSample: 0,
        baselineTeams: rawTotalTeams, sampleCurrentSeason: rawBaseline?.sampleCurrentSeason || 0,
        samplePreviousSeason: rawBaseline?.samplePreviousSeason || 0, sampleTotal: 0, competitionCoverage: rawTotalTeams,
        historySource: rawContext.standings ? (rawContextSource || "LIVE_API") : "NONE", freshness: rawContext.standings ? "LIVE" : "NONE"
      };

  return { contextDiagnosticBase, baselineDiagnostic, hasLocalModelContext, localMeta };
}
