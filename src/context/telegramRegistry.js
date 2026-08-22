export const TelegramSport = Object.freeze({
  FOOTBALL: "FOOTBALL", TENNIS: "TENNIS", HOCKEY: "HOCKEY",
  MULTISPORT: "MULTISPORT", OTHER: "OTHER", UNKNOWN: "UNKNOWN"
});

export const TelegramReliabilityStatus = Object.freeze({ UNRATED: "UNRATED", VERIFIED: "VERIFIED" });
export const TelegramResolutionStatus = Object.freeze({ RESOLVED: "RESOLVED", UNRESOLVED: "UNRESOLVED" });

export const EMPTY_TELEGRAM_PERFORMANCE = Object.freeze({
  picks: 0, gradedPicks: 0, wins: 0, losses: 0, pushes: 0,
  hitRate: null, roi: null, avgOdds: null, clv: null, sampleSize: 0
});

export const OWNER_SUPPLIED_TELEGRAM_IDENTIFIERS = Object.freeze([
  { kind: "USERNAME", value: "@luxebetanalyt", sourceId: "owner-telegram-5", resolutionStatus: TelegramResolutionStatus.RESOLVED },
  { kind: "USERNAME", value: "@MethodFidch", sourceId: "owner-telegram-1", resolutionStatus: TelegramResolutionStatus.RESOLVED },
  { kind: "USERNAME", value: "@jagsunci17", sourceId: "owner-telegram-7", resolutionStatus: TelegramResolutionStatus.RESOLVED },
  ...["-2129463592", "-1323146821", "-1274755089", "-1688959852", "-2100234097", "-1383890914"]
    .map(value => ({ kind: "CHANNEL_ID", value, sourceId: null, resolutionStatus: TelegramResolutionStatus.UNRESOLVED }))
]);

const mandatory = [
  { id: "owner-telegram-1", channelName: "Метод Фидча. Курилка.", sport: TelegramSport.UNKNOWN, username: "@MethodFidch", channelId: "-1001326262387", chatType: "channel", accessibility: "ACCESSIBLE" },
  { id: "owner-telegram-2", channelName: "game. set. press 🎾", sport: TelegramSport.TENNIS },
  { id: "owner-telegram-3", channelName: "Теннис🎾Чатик 💬", sport: TelegramSport.TENNIS },
  { id: "owner-telegram-4", channelName: "Бегущий по линии | Прогноз…", sport: TelegramSport.UNKNOWN },
  { id: "owner-telegram-5", channelName: "LUXEBET ANALYTICS ⚽️🏒", sport: TelegramSport.MULTISPORT, username: "@luxebetanalyt", channelId: "-1001462182022", chatType: "channel", accessibility: "ACCESSIBLE" },
  { id: "owner-telegram-6", channelName: "Dychkovsky 🎾", sport: TelegramSport.TENNIS }
];

export const VERIFIED_ADDITIONAL_TELEGRAM_SOURCES = Object.freeze([
  Object.freeze({
    id: "owner-telegram-7", platform: "TELEGRAM", mandatory: false, enabled: true,
    suppliedByOwner: true, channelName: "Kashin Bet | Теннис 🎾 ⚽️🥇", sport: TelegramSport.MULTISPORT,
    username: "@jagsunci17", channelId: "-1001237651098", chatType: "channel",
    accessibility: "ACCESSIBLE", resolutionStatus: TelegramResolutionStatus.RESOLVED,
    reliability: null, reliabilityStatus: TelegramReliabilityStatus.UNRATED,
    historicalStats: null, performance: { ...EMPTY_TELEGRAM_PERFORMANCE }
  })
]);

export const MANDATORY_TELEGRAM_SOURCES = Object.freeze(mandatory.map(source => Object.freeze({
  platform: "TELEGRAM", mandatory: true, enabled: true,
  channelId: null, username: null, chatType: null, accessibility: null,
  resolutionStatus: source.username ? TelegramResolutionStatus.RESOLVED : TelegramResolutionStatus.UNRESOLVED,
  reliability: null, reliabilityStatus: TelegramReliabilityStatus.UNRATED,
  historicalStats: null, performance: { ...EMPTY_TELEGRAM_PERFORMANCE }, ...source
})));

export function normalizeTelegramTitle(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ru")
    .replace(/[|.…]+$/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function normalizeTelegramUsername(value) {
  const username = String(value || "").trim().replace(/^@/, "").toLowerCase();
  return username || null;
}

export function matchTelegramMetadata(metadata, registry = []) {
  const channelId = metadata?.channelId ?? metadata?.id;
  const username = normalizeTelegramUsername(metadata?.username);
  const title = normalizeTelegramTitle(metadata?.sourceTitle || metadata?.title);
  const matches = registry.filter(source =>
    (channelId != null && source.channelId != null && String(source.channelId) === String(channelId)) ||
    (username && normalizeTelegramUsername(source.username) === username) ||
    (title && normalizeTelegramTitle(source.channelName) === title)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function mergeResolvedTelegramMetadata(registry = [], resolved = []) {
  const merged = registry.map(source => ({ ...source, performance: { ...source.performance } }));
  for (const metadata of resolved) {
    const source = matchTelegramMetadata(metadata, merged);
    if (!source) continue;
    if (metadata.id != null || metadata.channelId != null) source.channelId = metadata.channelId ?? metadata.id;
    if (metadata.username) source.username = `@${normalizeTelegramUsername(metadata.username)}`;
    source.chatType = metadata.chatType || metadata.type || source.chatType;
    source.accessibility = metadata.accessibility || source.accessibility;
    source.resolutionStatus = TelegramResolutionStatus.RESOLVED;
  }
  const unique = [];
  for (const source of merged) {
    const duplicate = unique.find(item =>
      (source.channelId != null && item.channelId != null && String(source.channelId) === String(item.channelId)) ||
      (normalizeTelegramUsername(source.username) && normalizeTelegramUsername(source.username) === normalizeTelegramUsername(item.username))
    );
    if (!duplicate) unique.push(source);
    else Object.assign(duplicate, { ...source, mandatory: duplicate.mandatory || source.mandatory });
  }
  return unique;
}

export function createTelegramSourceRegistry({ additionalNames = [], resolvedMetadata = [] } = {}) {
  const additional = additionalNames.filter(Boolean).map((channelName, index) => ({
    id: `configured-telegram-${index + 1}`, platform: "TELEGRAM", mandatory: false, enabled: true,
    sport: TelegramSport.UNKNOWN, channelName, channelId: null, username: null,
    chatType: null, accessibility: null, resolutionStatus: TelegramResolutionStatus.UNRESOLVED,
    reliability: null, reliabilityStatus: TelegramReliabilityStatus.UNRATED,
    historicalStats: null, performance: { ...EMPTY_TELEGRAM_PERFORMANCE }
  }));
  const byName = new Map();
  for (const source of [...MANDATORY_TELEGRAM_SOURCES, ...VERIFIED_ADDITIONAL_TELEGRAM_SOURCES, ...additional]) {
    if (!byName.has(source.channelName)) byName.set(source.channelName, { ...source, performance: { ...source.performance } });
  }
  return mergeResolvedTelegramMetadata([...byName.values()], resolvedMetadata);
}

export function telegramSourcesMissingIdentifiers(registry = []) {
  return registry.filter(source => source.enabled && source.channelId == null && !source.username);
}
