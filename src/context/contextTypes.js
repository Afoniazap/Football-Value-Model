export const ContextCategory = Object.freeze({
  COACH_INTERVIEW: "COACH_INTERVIEW",
  PLAYER_INTERVIEW: "PLAYER_INTERVIEW",
  MANAGEMENT_INTERVIEW: "MANAGEMENT_INTERVIEW",
  CLUB_NEWS: "CLUB_NEWS",
  MOTIVATION: "MOTIVATION",
  INTERNAL_CONFLICT: "INTERNAL_CONFLICT",
  FINANCIAL_PROBLEM: "FINANCIAL_PROBLEM",
  BONUS: "BONUS",
  PRESIDENT_VISIT: "PRESIDENT_VISIT",
  ROTATION_HINT: "ROTATION_HINT",
  TACTICAL_HINT: "TACTICAL_HINT",
  FATIGUE_HINT: "FATIGUE_HINT",
  TRAVEL_PROBLEM: "TRAVEL_PROBLEM",
  EXPERT_FORECAST: "EXPERT_FORECAST",
  OTHER: "OTHER"
});

export const ContextEventType = Object.freeze({
  COACH_INTERVIEW: "COACH_INTERVIEW",
  PLAYER_INTERVIEW: "PLAYER_INTERVIEW",
  PRESIDENT_VISIT: "PRESIDENT_VISIT",
  BONUS_PROMISE: "BONUS_PROMISE",
  PUBLIC_PRESSURE: "PUBLIC_PRESSURE",
  MANAGEMENT_CONFLICT: "MANAGEMENT_CONFLICT",
  ROTATION_EXPECTED: "ROTATION_EXPECTED",
  REST_PRIORITY: "REST_PRIORITY",
  TRAVEL_ISSUE: "TRAVEL_ISSUE",
  SQUAD_NEWS: "SQUAD_NEWS",
  MOTIVATION_HIGH: "MOTIVATION_HIGH",
  MOTIVATION_LOW: "MOTIVATION_LOW",
  OTHER: "OTHER"
});

export const ContextInformationLevel = Object.freeze({
  HIGH: "HIGH", STANDARD: "STANDARD", LOW_INFORMATION: "LOW_INFORMATION"
});

export const ContextSentiment = Object.freeze({ POSITIVE: "POSITIVE", NEGATIVE: "NEGATIVE", NEUTRAL: "NEUTRAL" });
export const ContextTarget = Object.freeze({ HOME: "HOME", AWAY: "AWAY", MATCH: "MATCH", UNKNOWN: "UNKNOWN" });
export const EvidenceType = Object.freeze({ FACT: "FACT", QUOTE: "QUOTE", REPORT: "REPORT", RUMOUR: "RUMOUR", EXPERT_OPINION: "EXPERT_OPINION" });

const extractedDefaults = Object.freeze({
  market: null, selection: null, odds: null, coachQuote: null, playerQuote: null,
  presidentVisit: false, bonusPromise: false, financialProblems: false,
  internalConflict: false, strongMotivation: false, rotationHint: false,
  fatigueHint: false, tacticalHint: false
});

function bounded(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : fallback;
}

export function normalizeContextEvent(input = {}) {
  const category = Object.values(ContextCategory).includes(input.category) ? input.category : ContextCategory.OTHER;
  const sentiment = Object.values(ContextSentiment).includes(input.sentiment) ? input.sentiment : ContextSentiment.NEUTRAL;
  const target = Object.values(ContextTarget).includes(input.target) ? input.target : ContextTarget.UNKNOWN;
  const evidenceType = Object.values(EvidenceType).includes(input.evidenceType) ? input.evidenceType : EvidenceType.REPORT;
  const eventType = Object.values(ContextEventType).includes(input.eventType) ? input.eventType : ContextEventType.OTHER;
  const informationLevel = Object.values(ContextInformationLevel).includes(input.informationLevel)
    ? input.informationLevel : ContextInformationLevel.STANDARD;
  const reliability = bounded(input.sourceReliability ?? input.reliability);
  const relevance = bounded(input.relevance);
  const freshness = bounded(input.freshness);
  return {
    source: String(input.source || "unknown"),
    sourceType: String(input.sourceType || category),
    evidenceType,
    fixtureId: input.fixtureId == null ? null : String(input.fixtureId),
    competition: String(input.competition || ""),
    homeTeam: String(input.homeTeam || ""),
    awayTeam: String(input.awayTeam || ""),
    fixtureDate: input.fixtureDate || null,
    publishedAt: input.publishedAt || null,
    author: input.author || null,
    url: String(input.url || ""),
    title: String(input.title || ""),
    text: String(input.text || ""),
    category,
    eventType,
    informationLevel,
    sentiment,
    target,
    sourceReliability: reliability,
    reliability,
    relevance,
    freshness,
    contextConfidence: bounded(input.contextConfidence ?? input.confidence),
    confidence: bounded(input.contextConfidence ?? input.confidence),
    fixtureMatchConfidence: bounded(input.fixtureMatchConfidence),
    tags: [...new Set((input.tags || []).map(tag => String(tag).trim().toLowerCase()).filter(Boolean))],
    extracted: { ...extractedDefaults, ...(input.extracted || {}) },
    evidence: input.evidence ? { ...input.evidence } : null,
    contradiction: Boolean(input.contradiction),
    independentSourcesCount: Math.max(1, Number(input.independentSourcesCount) || 1)
  };
}
