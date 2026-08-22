import { providerResult, SourceStatus } from "../../providers/providerResult.js";
import { ContextCategory, ContextSentiment, ContextTarget, EvidenceType, normalizeContextEvent } from "../contextTypes.js";
import { matchTelegramMetadata, TelegramSport, telegramSourcesMissingIdentifiers } from "../telegramRegistry.js";

export const TelegramPostType = Object.freeze({
  FACT: "FACT", QUOTE: "QUOTE", REPORT: "REPORT", RUMOUR: "RUMOUR",
  EXPERT_OPINION: "EXPERT_OPINION", BETTING_PICK: "BETTING_PICK",
  LINE_MOVEMENT_COMMENT: "LINE_MOVEMENT_COMMENT", MATCH_ANALYSIS: "MATCH_ANALYSIS"
});

export function detectTelegramSport(text, sourceSport = TelegramSport.UNKNOWN) {
  const value = String(text || "");
  const football = /\b(?:football|soccer|goal|premier league|champions league|serie a|la liga|bundesliga)\b|футбол|лига чемпионов|гол\b/iu.test(value);
  const tennis = /\b(?:tennis|atp|wta|grand slam|break point|tiebreak)\b|теннис|тай-?брейк|сет\b/iu.test(value);
  const hockey = /\b(?:hockey|nhl|khl|puck)\b|хоккей|нхл|кхл|шайб/iu.test(value);
  const detected = [football && TelegramSport.FOOTBALL, tennis && TelegramSport.TENNIS, hockey && TelegramSport.HOCKEY].filter(Boolean);
  if (detected.length > 1) return TelegramSport.MULTISPORT;
  if (football && !tennis) return TelegramSport.FOOTBALL;
  if (tennis && !football) return TelegramSport.TENNIS;
  if (hockey) return TelegramSport.HOCKEY;
  return sourceSport === TelegramSport.MULTISPORT ? TelegramSport.UNKNOWN : sourceSport;
}

function postType(text) {
  if (/(?:odds|коэф(?:фициент)?|@)\s*[:=]?\s*\d+[.,]\d+/iu.test(text) && /(?:pick|bet|ставк|прогноз|selection)/iu.test(text)) return TelegramPostType.BETTING_PICK;
  if (/line movement|odds (?:moved|dropped|shortened)|линия (?:двинулась|просела)|коэффициент (?:упал|вырос)/iu.test(text)) return TelegramPostType.LINE_MOVEMENT_COMMENT;
  if (/match analysis|разбор матча|тактический разбор|preview/iu.test(text)) return TelegramPostType.MATCH_ANALYSIS;
  if (/rumou?r|слух|неподтвержд/iu.test(text)) return TelegramPostType.RUMOUR;
  if (/[“"]([^”"]{15,})[”"]/u.test(text)) return TelegramPostType.QUOTE;
  if (/according to|сообщает|report(?:ed)?/iu.test(text)) return TelegramPostType.REPORT;
  return TelegramPostType.EXPERT_OPINION;
}

function extractMatch(text) {
  const match = String(text).match(/([\p{L}][\p{L}0-9 .'-]{1,35})\s+(?:vs\.?|v|-|—|–)\s+([\p{L}][\p{L}0-9 .'-]{1,35})/iu);
  return match ? { match: `${match[1].trim()} - ${match[2].trim()}`, homeTeam: match[1].trim(), awayTeam: match[2].trim() } : { match: null, homeTeam: "", awayTeam: "" };
}

export function extractTelegramPick(post, source) {
  const text = String(post.text || "");
  const teams = extractMatch(text);
  const odds = Number((text.match(/(?:odds|коэф(?:фициент)?|@)\s*[:=]?\s*(\d+[.,]\d+)/iu)?.[1] || "").replace(",", ".")) || null;
  const market = text.match(/\b(1x2|dnb|btts|over\s*\d+(?:[.,]\d+)?|under\s*\d+(?:[.,]\d+)?|тотал\s*[^,;\n]+)/iu)?.[1] || null;
  const selection = text.match(/(?:pick|selection|ставка|прогноз)\s*[:=-]\s*([^,;\n]+)/iu)?.[1]?.trim() || null;
  const bookmaker = text.match(/(?:bookmaker|букмекер)\s*[:=-]\s*([^,;\n]+)/iu)?.[1]?.trim() || null;
  const reasoning = text.match(/(?:reason|reasoning|обоснование|почему)\s*[:=-]\s*([^\n]+)/iu)?.[1]?.trim() || null;
  return {
    match: teams.match, sport: detectTelegramSport(text, source.sport), market, selection, odds, bookmaker,
    publishedAt: post.publishedAt || post.timestamp || null, author: post.author || null,
    messageId: post.messageId ?? null, reasoning, source: source.id, sourceChannel: source.channelName
  };
}

export function normalizeTelegramPost(post, source) {
  const type = Object.values(TelegramPostType).includes(post.telegramPostType)
    ? post.telegramPostType : postType(post.text || "");
  const sport = detectTelegramSport(post.text, source.sport);
  const teams = extractMatch(post.text || "");
  return {
    platform: "TELEGRAM", sourceId: source.id, sourceChannel: source.channelName,
    messageId: post.messageId ?? null,
    originalPublishedAt: post.publishedAt || post.timestamp || null,
    publishedAt: post.publishedAt || post.timestamp || null,
    editedAt: post.editedAt || null, channelId: post.channelId ?? source.channelId,
    username: post.username || source.username, sourceTitle: post.sourceTitle || source.channelName,
    author: post.author || null, text: String(post.text || ""), sport,
    telegramPostType: type, ...teams,
    pick: type === TelegramPostType.BETTING_PICK ? extractTelegramPick(post, source) : null
  };
}

export function telegramPostsToFvmEvents(posts = [], sources = []) {
  const byId = new Map(sources.map(source => [source.id, source]));
  const seen = new Set();
  return posts.flatMap(post => {
    const source = byId.get(post.sourceId) || matchTelegramMetadata(post, sources);
    if (!source || !source.enabled) return [];
    const identity = `${post.channelId ?? source.channelId ?? source.id}:${post.messageId ?? ""}`;
    if (post.messageId != null && seen.has(identity)) return [];
    if (post.messageId != null) seen.add(identity);
    const normalized = normalizeTelegramPost(post, source);
    if (normalized.sport !== TelegramSport.FOOTBALL) return [];
    const evidenceType = Object.values(EvidenceType).includes(normalized.telegramPostType)
      ? normalized.telegramPostType : EvidenceType.EXPERT_OPINION;
    return [normalizeContextEvent({
      source: source.id, sourceType: "TELEGRAM", evidenceType,
      homeTeam: normalized.homeTeam, awayTeam: normalized.awayTeam,
      publishedAt: normalized.publishedAt, author: normalized.author,
      title: normalized.pick?.match || normalized.telegramPostType,
      text: normalized.text, category: ContextCategory.OTHER,
      sentiment: ContextSentiment.NEUTRAL, target: ContextTarget.MATCH,
      sourceReliability: 0, relevance: 0, freshness: 0, contextConfidence: 0,
      tags: ["telegram", normalized.telegramPostType.toLowerCase()],
      extracted: { telegramPostType: normalized.telegramPostType, bettingPick: normalized.pick, sport: normalized.sport },
      evidence: {
        sourceUrl: post.sourceUrl || null, title: normalized.telegramPostType,
        publishedAt: normalized.publishedAt, snippet: normalized.text.slice(0, 260),
        speaker: normalized.author, extractionMethod: "TELEGRAM_POST_ADAPTER",
        messageId: normalized.messageId, originalPublishedAt: normalized.originalPublishedAt,
        editedAt: normalized.editedAt, channelId: normalized.channelId, username: normalized.username,
        sourceTitle: normalized.sourceTitle
      }
    })];
  });
}

export function isTelegramPostPreKickoff(post, fixture) {
  const published = new Date(post?.publishedAt || post?.timestamp).getTime();
  const kickoff = new Date(fixture?.utcDate || fixture?.kickoff).getTime();
  return Number.isFinite(published) && Number.isFinite(kickoff) && published < kickoff;
}

export async function fetchTelegramContext({ sources = [], posts = [] } = {}) {
  const events = telegramPostsToFvmEvents(posts, sources);
  const missing = telegramSourcesMissingIdentifiers(sources);
  return providerResult({
    status: events.length ? SourceStatus.OK : SourceStatus.NA,
    source: "context.telegram", data: events,
    meta: {
      configuredSources: sources.length,
      mandatorySources: sources.filter(source => source.mandatory).length,
      identifiersRequired: missing.map(source => source.channelName),
      postsReceived: posts.length, footballEvents: events.length,
      reason: events.length ? null : missing.length ? "IDENTIFIERS_REQUIRED" : "NO_POSTS",
      shadowOnly: true, unverifiedOpinion: true
    }
  });
}
