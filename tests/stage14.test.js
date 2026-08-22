import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTelegramClient, TelegramAuthStatus, telegramTokenAudit, validateTelegramBot } from "../src/telegram/client.js";
import { createTelegramSourceRegistry, mergeResolvedTelegramMetadata } from "../src/context/telegramRegistry.js";
import { telegramUpdateToPost } from "../src/context/telegramInbox.js";
import { createContextEngine } from "../src/context/contextEngine.js";
import { providerResult, SourceStatus } from "../src/providers/providerResult.js";

async function testBotValidation() {
  const valid = createTelegramClient({
    token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij",
    request: async () => ({ ok: true, result: { id: 42, username: "fvm_test_bot" } })
  });
  assert.equal(valid.audit.present, true);
  assert.equal((await validateTelegramBot(valid)).status, TelegramAuthStatus.VALID);
  assert.equal((await validateTelegramBot(valid)).bot.username, "@fvm_test_bot");

  const unauthorized = createTelegramClient({ token: "bad", request: async () => { throw new Error("401: Unauthorized"); } });
  assert.equal((await validateTelegramBot(unauthorized)).status, TelegramAuthStatus.UNAUTHORIZED);
  const missing = createTelegramClient({ token: "", request: async () => { throw new Error("must not run"); } });
  assert.equal((await validateTelegramBot(missing)).status, TelegramAuthStatus.MISSING_TOKEN);
  assert.equal(telegramTokenAudit("bad").formatPlausible, false);
}

function testChannelRouting() {
  const registry = mergeResolvedTelegramMetadata(createTelegramSourceRegistry(), [{ username: "@luxebetanalyt", channelId: -10055 }]);
  const channel = { id: -10055, username: "luxebetanalyt", title: "LUXEBET ANALYTICS ⚽️🏒", type: "channel" };
  const post = telegramUpdateToPost({ channel_post: { message_id: 8, date: 1_777_000_000, text: "football", chat: channel } }, registry);
  assert.equal(post.sourceId, "owner-telegram-5");
  const edit = telegramUpdateToPost({ edited_channel_post: { message_id: 8, date: 1_777_000_000, edit_date: 1_777_000_060, text: "football edited", chat: channel } }, registry);
  assert.equal(edit.messageId, post.messageId);
  assert.equal(edit.publishedAt, post.publishedAt);
  assert.ok(edit.editedAt);
  assert.equal(telegramUpdateToPost({ channel_post: { message_id: 9, date: 1, chat: { id: -999, title: "unknown" } } }, registry), null);
}

function testSingleConsumerAndCommands() {
  const app = fs.readFileSync(path.join(process.cwd(), "src", "app.js"), "utf8");
  assert.equal((app.match(/tg\("getUpdates"/g) || []).length, 1);
  assert.match(app, /"channel_post", "edited_channel_post"/);
  const ui = fs.readFileSync(path.join(process.cwd(), "src", "ui", "telegram.js"), "utf8");
  for (const command of ["/start", "/dashboard", "/refresh"]) assert.ok(ui.includes(command));
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node src/app.js");
}

async function testContextDisabledOnAuthFailure() {
  const runtimeRoot = fs.mkdtempSync(path.join(process.cwd(), ".telegram-auth-test-"));
  try {
    const engine = createContextEngine({
      runtimeRoot,
      config: {
        enabled: true, debug: false, telegramChannels: [], footboomTtlMinutes: 60,
        timeoutSeconds: 5, sourceWindowHours: 72, sourceTtlMinutes: 60,
        articleTtlMinutes: 360, maxArticlesPerSource: 1, sourceConcurrency: 1,
        reliability: { FOOTBOOM: 60 }
      },
      providers: {
        footboom: async () => providerResult({ status: SourceStatus.NA, source: "context.footboom", data: [] }),
        officialSources: async () => ({ providerResults: [], metrics: {} })
      }
    });
    engine.setTelegramAuthStatus(TelegramAuthStatus.UNAUTHORIZED);
    const result = await engine.collectFixtures([]);
    const telegram = result.providerResults.find(item => item.source === "context.telegram");
    assert.equal(telegram.status, SourceStatus.NA);
    assert.equal(telegram.meta.reason, "AUTH_ERROR");
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

await testBotValidation();
testChannelRouting();
testSingleConsumerAndCommands();
await testContextDisabledOnAuthFailure();
console.log("Stage 14 tests OK: bot auth, single polling consumer, routing, edits and existing commands.");
