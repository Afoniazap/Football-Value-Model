export const TelegramSport = Object.freeze({
  FOOTBALL: "FOOTBALL", TENNIS: "TENNIS", MULTISPORT: "MULTISPORT", UNKNOWN: "UNKNOWN"
});

export const TelegramReliabilityStatus = Object.freeze({ UNRATED: "UNRATED", VERIFIED: "VERIFIED" });

export const EMPTY_TELEGRAM_PERFORMANCE = Object.freeze({
  picks: 0, wins: 0, losses: 0, pushes: 0,
  hitRate: null, roi: null, avgOdds: null, clv: null, sampleSize: 0
});

export const MANDATORY_TELEGRAM_SOURCES = Object.freeze([
  { id: "owner-telegram-1", channelName: "Метод Фидча. Курилка.", sport: TelegramSport.UNKNOWN },
  { id: "owner-telegram-2", channelName: "game. set. press 🎾", sport: TelegramSport.TENNIS },
  { id: "owner-telegram-3", channelName: "Теннис🎾Чатик 💬", sport: TelegramSport.TENNIS },
  { id: "owner-telegram-4", channelName: "Бегущий по линии | Прогноз…", sport: TelegramSport.UNKNOWN },
  { id: "owner-telegram-5", channelName: "LUXEBET ANALYTICS ⚽️🏒", sport: TelegramSport.MULTISPORT },
  { id: "owner-telegram-6", channelName: "Dychkovsky 🎾", sport: TelegramSport.TENNIS }
].map(source => Object.freeze({
  platform: "TELEGRAM", mandatory: true, enabled: true,
  channelId: null, username: null, reliability: null,
  reliabilityStatus: TelegramReliabilityStatus.UNRATED,
  historicalStats: null, performance: { ...EMPTY_TELEGRAM_PERFORMANCE },
  ...source
})));

export function createTelegramSourceRegistry({ additionalNames = [] } = {}) {
  const additional = additionalNames.filter(Boolean).map((channelName, index) => ({
    id: `configured-telegram-${index + 1}`,
    platform: "TELEGRAM", mandatory: false, enabled: true,
    sport: TelegramSport.UNKNOWN, channelName,
    channelId: null, username: null, reliability: null,
    reliabilityStatus: TelegramReliabilityStatus.UNRATED,
    historicalStats: null, performance: { ...EMPTY_TELEGRAM_PERFORMANCE }
  }));
  const byName = new Map();
  for (const source of [...MANDATORY_TELEGRAM_SOURCES, ...additional]) {
    if (!byName.has(source.channelName)) byName.set(source.channelName, { ...source, performance: { ...source.performance } });
  }
  return [...byName.values()];
}

export function telegramSourcesMissingIdentifiers(registry = []) {
  return registry.filter(source => source.enabled && source.channelId == null && !source.username);
}
