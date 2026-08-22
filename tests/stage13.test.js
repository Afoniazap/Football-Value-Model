import assert from "node:assert/strict";
import {
  createTelegramSourceRegistry,
  EMPTY_TELEGRAM_PERFORMANCE,
  MANDATORY_TELEGRAM_SOURCES,
  TelegramSport,
  telegramSourcesMissingIdentifiers
} from "../src/context/telegramRegistry.js";
import {
  extractTelegramPick,
  fetchTelegramContext,
  normalizeTelegramPost,
  TelegramPostType,
  telegramPostsToFvmEvents
} from "../src/context/providers/telegram.js";
import { SourceStatus } from "../src/providers/providerResult.js";
import { combineContextSourceRegistries } from "../src/context/sourceRegistry.js";

const expectedNames = [
  "Метод Фидча. Курилка.",
  "game. set. press 🎾",
  "Теннис🎾Чатик 💬",
  "Бегущий по линии | Прогноз…",
  "LUXEBET ANALYTICS ⚽️🏒",
  "Dychkovsky 🎾"
];

function testMandatoryRegistry() {
  const registry = createTelegramSourceRegistry();
  assert.deepEqual(registry.map(source => source.channelName), expectedNames);
  assert.equal(MANDATORY_TELEGRAM_SOURCES.length, 6);
  assert.ok(registry.every(source => source.platform === "TELEGRAM"));
  assert.ok(registry.every(source => source.mandatory && source.enabled));
  assert.ok(registry.every(source => source.channelId === null && source.username === null));
  assert.ok(registry.every(source => source.reliability === null && source.reliabilityStatus === "UNRATED"));
  assert.ok(registry.every(source => source.historicalStats === null));
  assert.ok(registry.every(source => JSON.stringify(source.performance) === JSON.stringify(EMPTY_TELEGRAM_PERFORMANCE)));
  assert.equal(telegramSourcesMissingIdentifiers(registry).length, 6);
  assert.equal(combineContextSourceRegistries([{ id: "web" }], registry).length, 7);
  assert.equal(registry.find(source => source.channelName === "LUXEBET ANALYTICS ⚽️🏒").sport, TelegramSport.MULTISPORT);
  assert.equal(registry.find(source => source.channelName === "Dychkovsky 🎾").sport, TelegramSport.TENNIS);
}

function testPickExtractionAndOriginalIdentity() {
  const source = createTelegramSourceRegistry().find(item => item.channelName === "LUXEBET ANALYTICS ⚽️🏒");
  const post = {
    sourceId: source.id,
    messageId: 4711,
    publishedAt: "2026-08-22T10:00:00Z",
    author: "Channel author",
    text: "Inter - Monza\nФутбол. Ставка: Inter DNB\nКоэффициент: 1.85\nБукмекер: Example\nОбоснование: домашний матч"
  };
  const normalized = normalizeTelegramPost(post, source);
  assert.equal(normalized.telegramPostType, TelegramPostType.BETTING_PICK);
  assert.equal(normalized.sport, TelegramSport.FOOTBALL);
  assert.equal(normalized.messageId, 4711);
  assert.equal(normalized.originalPublishedAt, post.publishedAt);
  const pick = extractTelegramPick(post, source);
  assert.equal(pick.match, "Inter - Monza");
  assert.equal(pick.market.toLowerCase(), "dnb");
  assert.equal(pick.selection, "Inter DNB");
  assert.equal(pick.odds, 1.85);
  assert.equal(pick.bookmaker, "Example");
  assert.equal(pick.reasoning, "домашний матч");
  assert.equal(pick.sourceChannel, source.channelName);

  const events = telegramPostsToFvmEvents([post], [source]);
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceReliability, 0);
  assert.equal(events[0].contextConfidence, 0);
  assert.equal(events[0].extracted.telegramPostType, TelegramPostType.BETTING_PICK);
  assert.equal(events[0].evidence.messageId, 4711);
  assert.equal(events[0].evidence.originalPublishedAt, post.publishedAt);
}

function testSportIsolationAndPostTypes() {
  const registry = createTelegramSourceRegistry();
  const tennis = registry.find(source => source.sport === TelegramSport.TENNIS);
  const multisport = registry.find(source => source.sport === TelegramSport.MULTISPORT);
  const tennisPost = { sourceId: tennis.id, messageId: 1, timestamp: "2026-08-22T09:00:00Z", text: "ATP tennis: Player A - Player B, первый сет" };
  assert.equal(telegramPostsToFvmEvents([tennisPost], registry).length, 0);
  assert.equal(normalizeTelegramPost({ text: "Коэффициент упал: line movement", telegramPostType: TelegramPostType.LINE_MOVEMENT_COMMENT }, multisport).telegramPostType, TelegramPostType.LINE_MOVEMENT_COMMENT);
  assert.equal(normalizeTelegramPost({ text: "Confirmed source post", telegramPostType: TelegramPostType.FACT }, multisport).telegramPostType, TelegramPostType.FACT);
}

async function testProviderRequiresIdentifiers() {
  const registry = createTelegramSourceRegistry();
  const result = await fetchTelegramContext({ sources: registry, posts: [] });
  assert.equal(result.status, SourceStatus.NA);
  assert.equal(result.meta.reason, "IDENTIFIERS_REQUIRED");
  assert.equal(result.meta.mandatorySources, 6);
  assert.deepEqual(result.meta.identifiersRequired, expectedNames);
  assert.equal(result.meta.shadowOnly, true);
}

testMandatoryRegistry();
testPickExtractionAndOriginalIdentity();
testSportIsolationAndPostTypes();
await testProviderRequiresIdentifiers();

console.log("Stage 13 tests OK: mandatory Telegram registry, unrated metadata, sport isolation, shadow picks, post identity and identifier safeguards.");
