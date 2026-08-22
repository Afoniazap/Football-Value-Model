import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTelegramSourceRegistry, EMPTY_TELEGRAM_PERFORMANCE, MANDATORY_TELEGRAM_SOURCES,
  matchTelegramMetadata, mergeResolvedTelegramMetadata, OWNER_SUPPLIED_TELEGRAM_IDENTIFIERS,
  TelegramSport, telegramSourcesMissingIdentifiers
} from "../src/context/telegramRegistry.js";
import {
  detectTelegramSport, extractTelegramPick, fetchTelegramContext, isTelegramPostPreKickoff,
  normalizeTelegramPost, TelegramPostType, telegramPostsToFvmEvents
} from "../src/context/providers/telegram.js";
import { resolveTelegramIdentifiers } from "../src/context/telegramResolver.js";
import { createTelegramInbox, telegramUpdateToPost } from "../src/context/telegramInbox.js";
import { calculateTelegramPerformance } from "../src/context/telegramPerformance.js";
import { SourceStatus } from "../src/providers/providerResult.js";

const expectedNames = [
  "Метод Фидча. Курилка.", "game. set. press 🎾", "Теннис🎾Чатик 💬",
  "Бегущий по линии | Прогноз…", "LUXEBET ANALYTICS ⚽️🏒", "Dychkovsky 🎾"
];

function testMandatoryRegistryAndOwnerMappings() {
  const registry = createTelegramSourceRegistry();
  assert.deepEqual(registry.map(source => source.channelName), expectedNames);
  assert.equal(MANDATORY_TELEGRAM_SOURCES.length, 6);
  assert.equal(OWNER_SUPPLIED_TELEGRAM_IDENTIFIERS.length, 9);
  assert.equal(registry.find(source => source.id === "owner-telegram-1").username, "@MethodFidch");
  assert.equal(registry.find(source => source.id === "owner-telegram-5").username, "@luxebetanalyt");
  assert.equal(telegramSourcesMissingIdentifiers(registry).length, 4);
  assert.ok(registry.every(source => source.reliability === null && source.reliabilityStatus === "UNRATED"));
  assert.ok(registry.every(source => JSON.stringify(source.performance) === JSON.stringify(EMPTY_TELEGRAM_PERFORMANCE)));
}

function testMatchingAndDeduplication() {
  const registry = createTelegramSourceRegistry();
  assert.equal(matchTelegramMetadata({ username: "luxebetanalyt" }, registry).id, "owner-telegram-5");
  assert.equal(matchTelegramMetadata({ title: "  LUXEBET ANALYTICS ⚽️🏒  " }, registry).id, "owner-telegram-5");
  assert.equal(matchTelegramMetadata({ title: "not registered" }, registry), null);
  const withId = mergeResolvedTelegramMetadata(registry, [{ username: "@luxebetanalyt", channelId: -10055, type: "channel" }]);
  assert.equal(withId.length, 6);
  assert.equal(matchTelegramMetadata({ channelId: -10055 }, withId).username, "@luxebetanalyt");
}

async function testResolverAndAccessFailures() {
  const registry = createTelegramSourceRegistry();
  const resolved = await resolveTelegramIdentifiers({
    identifiers: [{ value: "@luxebetanalyt" }, { value: "-private" }, { value: "-unknown" }], registry,
    getChat: async value => {
      if (value === "@luxebetanalyt") return { id: -10055, username: "luxebetanalyt", title: "LUXEBET ANALYTICS ⚽️🏒", type: "channel" };
      if (value === "-private") throw new Error("Forbidden: private channel");
      return { id: -10099, title: "Unrelated", type: "supergroup" };
    }
  });
  assert.equal(resolved.results[0].resolutionStatus, "RESOLVED");
  assert.equal(resolved.results[1].failure, "INACCESSIBLE_OR_PRIVATE");
  assert.equal(resolved.results[2].resolutionStatus, "UNRESOLVED");
  assert.equal(resolved.registry.find(source => source.id === "owner-telegram-5").channelId, -10055);
}

function testClassificationPickAndTemporalSafety() {
  const source = createTelegramSourceRegistry().find(item => item.id === "owner-telegram-5");
  const post = {
    sourceId: source.id, channelId: -10055, messageId: 4711,
    publishedAt: "2026-08-22T10:00:00Z", editedAt: "2026-08-22T10:05:00Z",
    text: "Inter - Monza\nФутбол. Ставка: Inter DNB\nКоэффициент: 1.85\nБукмекер: Example"
  };
  const normalized = normalizeTelegramPost(post, source);
  assert.equal(normalized.telegramPostType, TelegramPostType.BETTING_PICK);
  assert.equal(normalized.sport, TelegramSport.FOOTBALL);
  assert.equal(normalized.editedAt, post.editedAt);
  const pick = extractTelegramPick(post, source);
  assert.equal(pick.messageId, 4711);
  assert.equal(pick.odds, 1.85);
  assert.equal(detectTelegramSport("ATP tennis first set", TelegramSport.MULTISPORT), TelegramSport.TENNIS);
  assert.equal(detectTelegramSport("НХЛ хоккей, тотал шайб", TelegramSport.MULTISPORT), TelegramSport.HOCKEY);
  assert.equal(detectTelegramSport("футбол и теннис", TelegramSport.MULTISPORT), TelegramSport.MULTISPORT);
  assert.equal(isTelegramPostPreKickoff(post, { utcDate: "2026-08-22T11:00:00Z" }), true);
  assert.equal(isTelegramPostPreKickoff(post, { utcDate: "2026-08-22T10:00:00Z" }), false);

  const events = telegramPostsToFvmEvents([post, post], [source]);
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceReliability, 0);
  assert.equal(events[0].evidence.editedAt, post.editedAt);
  assert.equal(telegramPostsToFvmEvents([{ ...post, text: "ATP tennis match" }], [source]).length, 0);
}

function testUpdateIngestionAndEditedIdentity() {
  const registry = mergeResolvedTelegramMetadata(createTelegramSourceRegistry(), [{ username: "@luxebetanalyt", channelId: -10055 }]);
  const base = { update_id: 1, channel_post: { message_id: 7, date: 1_777_000_000, text: "football report", chat: { id: -10055, username: "luxebetanalyt", title: "LUXEBET ANALYTICS ⚽️🏒", type: "channel" } } };
  const post = telegramUpdateToPost(base, registry);
  assert.equal(post.messageId, 7);
  assert.equal(post.editedAt, null);
  const edited = telegramUpdateToPost({ edited_channel_post: { ...base.channel_post, edit_date: 1_777_000_060, text: "football edited" } }, registry);
  assert.equal(edited.publishedAt, post.publishedAt);
  assert.ok(edited.editedAt > edited.publishedAt);
  assert.equal(telegramUpdateToPost({ channel_post: { ...base.channel_post, chat: { id: -999, title: "Private unknown" } } }, registry), null);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-telegram-"));
  const inbox = createTelegramInbox(temp);
  inbox.appendUpdate(base, registry);
  inbox.appendUpdate({ edited_channel_post: { ...base.channel_post, edit_date: 1_777_000_060, text: "football edited" } }, registry);
  assert.equal(inbox.readRecent().length, 1);
  assert.equal(inbox.readRecent()[0].text, "football edited");
}

function testIndependentPerformance() {
  const performance = calculateTelegramPerformance([
    { pick: { odds: 2 }, independentlyVerified: true, outcome: "WIN", clv: 0.05 },
    { pick: { odds: 1.8 }, independentlyVerified: true, outcome: "LOSS", clv: -0.02 },
    { pick: { odds: 3 }, independentlyVerified: false, outcome: "WIN" }
  ]);
  assert.equal(performance.picks, 3);
  assert.equal(performance.gradedPicks, 2);
  assert.equal(performance.wins, 1);
  assert.equal(performance.losses, 1);
  assert.equal(performance.hitRate, 0.5);
  assert.equal(performance.roi, 0);
  assert.equal(performance.avgOdds, 1.9);
  assert.ok(Math.abs(performance.clv - 0.015) < 1e-12);
}

async function testProviderStatus() {
  const result = await fetchTelegramContext({ sources: createTelegramSourceRegistry(), posts: [] });
  assert.equal(result.status, SourceStatus.NA);
  assert.equal(result.meta.reason, "IDENTIFIERS_REQUIRED");
  assert.equal(result.meta.shadowOnly, true);
}

testMandatoryRegistryAndOwnerMappings();
testMatchingAndDeduplication();
await testResolverAndAccessFailures();
testClassificationPickAndTemporalSafety();
testUpdateIngestionAndEditedIdentity();
testIndependentPerformance();
await testProviderStatus();

console.log("Stage 13 tests OK: Telegram resolution, dedup, shadow ingestion, sports, edits, temporal safety and independent performance.");
