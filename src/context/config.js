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
  return {
    enabled: String(env.CONTEXT_INTELLIGENCE_ENABLED || "false").toLowerCase() === "true",
    debug: String(env.CONTEXT_DEBUG || "false").toLowerCase() === "true",
    cacheTtlMinutes: number("CONTEXT_CACHE_TTL_MINUTES", 60),
    footboomTtlMinutes: number("CONTEXT_FOOTBOOM_TTL_MINUTES", 60),
    timeoutSeconds: number("CONTEXT_REQUEST_TIMEOUT_SECONDS", 15, 5),
    telegramChannels: String(env.CONTEXT_TELEGRAM_CHANNELS || "").split(",").map(value => value.trim()).filter(Boolean),
    reliability: {
      ...DEFAULT_CONTEXT_RELIABILITY,
      FOOTBOOM: Math.min(100, number("CONTEXT_FOOTBOOM_RELIABILITY", DEFAULT_CONTEXT_RELIABILITY.FOOTBOOM)),
      TELEGRAM: Math.min(100, number("CONTEXT_TELEGRAM_RELIABILITY", DEFAULT_CONTEXT_RELIABILITY.TELEGRAM))
    }
  };
}
