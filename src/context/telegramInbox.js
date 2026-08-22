import fs from "node:fs";
import path from "node:path";
import { matchTelegramMetadata } from "./telegramRegistry.js";

function isoFromUnix(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Date(number * 1000).toISOString() : null;
}

export function telegramUpdateToPost(update, registry = []) {
  const message = update?.channel_post || update?.edited_channel_post;
  if (!message?.chat || message.message_id == null) return null;
  const metadata = {
    channelId: message.chat.id, username: message.chat.username || null,
    sourceTitle: message.chat.title || null, chatType: message.chat.type || null
  };
  const source = matchTelegramMetadata(metadata, registry);
  if (!source) return null;
  return {
    sourceId: source.id, channelId: message.chat.id,
    username: message.chat.username ? `@${message.chat.username}` : source.username,
    messageId: message.message_id, publishedAt: isoFromUnix(message.date),
    editedAt: isoFromUnix(message.edit_date), text: message.text || message.caption || "",
    sourceTitle: message.chat.title || source.channelName, chatType: message.chat.type || null
  };
}

export function createTelegramInbox(runtimeRoot) {
  const directory = path.join(runtimeRoot, "context");
  const file = path.join(directory, "telegram-posts.jsonl");

  function appendUpdate(update, registry) {
    const post = telegramUpdateToPost(update, registry);
    if (!post) return null;
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(post)}\n`, "utf8");
    return post;
  }

  function readRecent({ limit = 500 } = {}) {
    if (!fs.existsSync(file)) return [];
    const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-Math.max(limit * 2, limit));
    const latest = new Map();
    for (const row of rows) {
      try {
        const post = JSON.parse(row);
        latest.set(`${post.channelId}:${post.messageId}`, post);
      } catch { /* Повреждённая runtime-строка не должна останавливать FVM. */ }
    }
    return [...latest.values()].slice(-limit);
  }

  function appendPosts(posts = []) {
    const existing = new Map(readRecent({ limit: 2_000 }).map(post => [`${post.channelId || post.username}:${post.messageId}`, post]));
    const added = [];
    for (const post of posts) {
      if (!post || post.messageId == null || !post.publishedAt) continue;
      const key = `${post.channelId || post.username}:${post.messageId}`;
      const previous = existing.get(key);
      if (previous && previous.text === post.text && previous.editedAt === post.editedAt) continue;
      added.push(post); existing.set(key, post);
    }
    if (added.length) {
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(file, `${added.map(post => JSON.stringify(post)).join("\n")}\n`, "utf8");
    }
    return added;
  }

  return { file, appendUpdate, appendPosts, readRecent };
}
