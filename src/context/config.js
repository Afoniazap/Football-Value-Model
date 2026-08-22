export const DEFAULT_CONTEXT_RELIABILITY = Object.freeze({
  OFFICIAL_CLUB_STATEMENT: 90,
  OFFICIAL_COACH_INTERVIEW: 90,
  OFFICIAL_PLAYER_INTERVIEW: 85,
  REPUTABLE_SPORTS_MEDIA: 75,
  FOOTBOOM: 60,
  TELEGRAM: 30,
  ANONYMOUS_UNVERIFIED: 25
});

export function contextConfigFromEnv(env = process.env) {
  const number = (name, fallback, min = 1) => Math.max(min, Number(env[name]) || fallback);
  let sourceRegistry = null;
  try { sourceRegistry = env.CONTEXT_SOURCE_REGISTRY_JSON ? JSON.parse(env.CONTEXT_SOURCE_REGISTRY_JSON) : null; } catch { sourceRegistry = null; }
  return {
    enabled: String(env.CONTEXT_INTELLIGENCE_ENABLED || "false").toLowerCase() === "true",
    debug: String(env.CONTEXT_DEBUG || "false").toLowerCase() === "true",
    cacheTtlMinutes: number("CONTEXT_CACHE_TTL_MINUTES", 60),
    footboomTtlMinutes: number("CONTEXT_FOOTBOOM_TTL_MINUTES", 60),
    timeoutSeconds: number("CONTEXT_REQUEST_TIMEOUT_SECONDS", 15, 5),
    sourceWindowHours: number("CONTEXT_SOURCE_WINDOW_HOURS", 72),
    sourceTtlMinutes: number("CONTEXT_SOURCE_TTL_MINUTES", 60),
    articleTtlMinutes: number("CONTEXT_ARTICLE_TTL_MINUTES", 360),
    minHostIntervalMs: number("CONTEXT_MIN_HOST_INTERVAL_MS", 1000),
    sourceConcurrency: Math.min(4, number("CONTEXT_SOURCE_CONCURRENCY", 2)),
    maxArticlesPerSource: Math.min(10, number("CONTEXT_MAX_ARTICLES_PER_SOURCE", 3)),
    sourceRegistry: Array.isArray(sourceRegistry) ? sourceRegistry : null,
    enabledSourceIds: String(env.CONTEXT_ENABLED_SOURCE_IDS || "").split(",").map(value => value.trim()).filter(Boolean),
    telegramChannels: String(env.CONTEXT_TELEGRAM_CHANNELS || "").split(",").map(value => value.trim()).filter(Boolean),
    reliability: {
      ...DEFAULT_CONTEXT_RELIABILITY,
      FOOTBOOM: Math.min(100, number("CONTEXT_FOOTBOOM_RELIABILITY", DEFAULT_CONTEXT_RELIABILITY.FOOTBOOM)),
      TELEGRAM: Math.min(100, number("CONTEXT_TELEGRAM_RELIABILITY", DEFAULT_CONTEXT_RELIABILITY.TELEGRAM)),
      OFFICIAL_CLUB: Math.min(100, number("CONTEXT_OFFICIAL_CLUB_RELIABILITY", 90)),
      OFFICIAL_LEAGUE: Math.min(100, number("CONTEXT_OFFICIAL_LEAGUE_RELIABILITY", 88)),
      OFFICIAL_FEDERATION: Math.min(100, number("CONTEXT_OFFICIAL_FEDERATION_RELIABILITY", 90)),
      REPUTABLE_MEDIA: Math.min(100, number("CONTEXT_REPUTABLE_MEDIA_RELIABILITY", 75))
    }
  };
}
