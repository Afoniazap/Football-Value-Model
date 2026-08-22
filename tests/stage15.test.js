import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelegramInbox } from "../src/context/telegramInbox.js";
import { fetchPublicTelegramSources, parseTelegramPublicPage, TelegramReadAccess } from "../src/context/providers/telegramPublic.js";
import { telegramPostsToFvmEvents } from "../src/context/providers/telegram.js";
import { createTelegramSourceRegistry } from "../src/context/telegramRegistry.js";

const source = createTelegramSourceRegistry().find(item => item.username === "@jagsunci17");
const html = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="jagsunci17/101">
    <div class="tgme_widget_message_text js-message_text">Футбол. Inter - Monza<br>Ставка: Inter DNB<br>Коэффициент: 1.85</div>
    <a class="tgme_widget_message_date" href="https://t.me/jagsunci17/101"><time datetime="2026-08-22T10:00:00+00:00"></time></a>
    <span class="tgme_widget_message_edit_date"><time datetime="2026-08-22T10:05:00+00:00"></time></span>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="jagsunci17/102">
    <div class="tgme_widget_message_text js-message_text">ATP tennis first set analysis</div>
    <a class="tgme_widget_message_date" href="https://t.me/jagsunci17/102"><time datetime="2026-08-22T11:00:00+00:00"></time></a>
  </div>
</div>`;

function testPublicParserAndClassification() {
  const posts = parseTelegramPublicPage(html, source);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].messageId, 101);
  assert.equal(posts[0].publishedAt, "2026-08-22T10:00:00+00:00");
  assert.equal(posts[0].editedAt, "2026-08-22T10:05:00+00:00");
  assert.equal(posts[0].sourceUrl, "https://t.me/jagsunci17/101");
  const events = telegramPostsToFvmEvents(posts, [source]);
  assert.equal(events.length, 1);
  assert.equal(events[0].extracted.sport, "FOOTBALL");
  assert.equal(events[0].extracted.telegramPostType, "BETTING_PICK");
  assert.equal(events[0].evidence.sourceUrl, posts[0].sourceUrl);
}

async function testReadOnlyFetchAndInboxDedup() {
  const state = new Map();
  const cache = { get: key => state.get(key) || null, set: (key, value) => state.set(key, value) };
  let requests = 0;
  const httpClient = { fetchText: async url => { requests += 1; assert.equal(url, "https://t.me/s/jagsunci17"); return html; } };
  const result = await fetchPublicTelegramSources({ sources: [source], httpClient, cache, ttlMinutes: 15 });
  assert.equal(result.posts.length, 2);
  assert.equal(result.providerResults[0].meta.access, TelegramReadAccess.READABLE_PUBLIC);
  assert.equal(requests, 1);
  const cached = await fetchPublicTelegramSources({ sources: [source], httpClient, cache, ttlMinutes: 15 });
  assert.equal(cached.posts.length, 2);
  assert.equal(requests, 1);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-public-telegram-"));
  const inbox = createTelegramInbox(root);
  assert.equal(inbox.appendPosts(result.posts).length, 2);
  assert.equal(inbox.appendPosts(result.posts).length, 0);
  assert.equal(inbox.readRecent().length, 2);
}

function testUnresolvedSourceStatus() {
  return fetchPublicTelegramSources({
    sources: [{ id: "private", enabled: true, username: null }],
    httpClient: { fetchText: async () => { throw new Error("must not fetch"); } },
    cache: { get: () => null, set: () => {} }
  }).then(result => assert.equal(result.providerResults[0].meta.access, TelegramReadAccess.UNRESOLVED));
}

testPublicParserAndClassification();
await testReadOnlyFetchAndInboxDedup();
await testUnresolvedSourceStatus();
console.log("Stage 15 tests OK: public Telegram parsing, read-only fetch, cache, shadow routing and inbox dedup.");
