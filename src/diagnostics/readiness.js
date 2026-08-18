import { SourceStatus } from "../providers/providerResult.js";

function configured(value) {
  return Boolean(String(value || "").trim());
}

export function startupReadiness(config) {
  return {
    secrets: {
      telegram: configured(config.telegramToken),
      footballData: configured(config.footballDataToken),
      theOddsApi: configured(config.oddsApiKey),
      oddsApiIo: configured(config.oddsApiIoKey),
      apiFootball: configured(config.apiFootballKey),
      sportmonksXg: configured(config.sportmonksApiKey),
      theStatsApiXg: configured(config.theStatsApiKey)
    },
    validation: {
      horizonHours: config.horizonHours,
      refreshMinutes: config.refreshMinutes,
      oddsFreshMinutes: config.oddsFreshMinutes,
      oddsStaleMinutes: config.oddsStaleMinutes,
      closingWindowMinutes: config.closingWindowMinutes,
      allowedChatIds: config.allowedChatIds?.size || 0,
      marketMatchMinConfidence: config.marketMatchMinConfidence
    }
  };
}

export function readinessState({ config, providerHealth = {}, marketCoverage = null }) {
  const coreConfigured = configured(config.telegramToken) &&
    configured(config.footballDataToken) &&
    (config.allowedChatIds?.size || 0) > 0;
  if (!coreConfigured) return { status: "NOT_READY", reason: "CONFIG_INVALID" };

  const fixtures = providerHealth["football-data.fixtures"];
  if (fixtures && ![SourceStatus.OK, SourceStatus.PARTIAL].includes(fixtures.status)) {
    return { status: "NOT_READY", reason: `FIXTURES_${fixtures.status}` };
  }

  const hasConfiguredMarket = configured(config.oddsApiKey) ||
    configured(config.oddsApiIoKey) ||
    configured(config.apiFootballKey);
  if (!hasConfiguredMarket) return { status: "DEGRADED", reason: "NO_MARKET_PROVIDER_CONFIGURED" };

  if (marketCoverage && marketCoverage.numerator > 0) {
    return { status: "READY", reason: "FIXTURES_AND_MARKET_AVAILABLE" };
  }

  const marketStatuses = [
    providerHealth.odds?.status,
    ...Object.entries(providerHealth)
      .filter(([source]) => source.startsWith("odds."))
      .map(([, health]) => health.status),
    providerHealth["market.cache"]?.meta?.fresh ? SourceStatus.OK : null
  ];
  return marketStatuses.includes(SourceStatus.OK)
    ? { status: "READY", reason: "MARKET_PROVIDER_OK" }
    : { status: "DEGRADED", reason: "MARKET_UNAVAILABLE_OR_CACHE_ONLY" };
}

export function readinessLines(readiness) {
  const yesNo = value => value ? "YES" : "NO";
  const s = readiness.secrets;
  const v = readiness.validation;
  return [
    `Telegram: configured ${yesNo(s.telegram)}`,
    `football-data: configured ${yesNo(s.footballData)}`,
    `The Odds API: configured ${yesNo(s.theOddsApi)}`,
    `odds-api.io: configured ${yesNo(s.oddsApiIo)}`,
    `API-Football: configured ${yesNo(s.apiFootball)}`,
    `Sportmonks xG: configured ${yesNo(s.sportmonksXg)}`,
    `TheStatsAPI xG: configured ${yesNo(s.theStatsApiXg)}`,
    `HORIZON_HOURS: ${v.horizonHours}`,
    `refresh interval: ${v.refreshMinutes} min`,
    `market freshness: fresh ${v.oddsFreshMinutes} min / stale ${v.oddsStaleMinutes} min`,
    `closing window: ${v.closingWindowMinutes} min`,
    `allowed chat IDs: ${v.allowedChatIds}`
  ];
}
