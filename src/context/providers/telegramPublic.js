import { stripHtml } from "../articleParser.js";
import { mapWithConcurrency } from "../requestControl.js";
import { providerResult, SourceStatus } from "../../providers/providerResult.js";

export const TelegramReadAccess = Object.freeze({
  READABLE_PUBLIC: "READABLE_PUBLIC", READABLE_AUTHORIZED: "READABLE_AUTHORIZED",
  BOT_DELIVERY_ONLY: "BOT_DELIVERY_ONLY", PRIVATE: "PRIVATE", BLOCKED: "BLOCKED", UNRESOLVED: "UNRESOLVED"
});

function attribute(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`${escaped}=["']([^"']+)["']`, "i"))?.[1] || null;
}

export function parseTelegramPublicPage(html, source) {
  const chunks = String(html || "").split(/(?=<div class="tgme_widget_message_wrap)/g);
  const posts = [];
  for (const chunk of chunks) {
    const postRef = attribute(chunk, "data-post");
    if (!postRef || !postRef.includes("/")) continue;
    const messageId = Number(postRef.slice(postRef.lastIndexOf("/") + 1));
    const publishedAt = chunk.match(/<a[^>]+class="tgme_widget_message_date[^>]*>[\s\S]*?<time[^>]+datetime="([^"]+)"/i)?.[1] || null;
    const editedAt = chunk.match(/tgme_widget_message_edit_date[\s\S]*?<time[^>]+datetime="([^"]+)"/i)?.[1] || null;
    const textHtml = chunk.match(/<div[^>]+class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
    const sourceUrl = chunk.match(/<a[^>]+class="tgme_widget_message_date[^>]+href="([^"]+)"/i)?.[1] || `https://t.me/${postRef}`;
    if (!Number.isFinite(messageId) || !publishedAt) continue;
    posts.push({
      sourceId: source.id, channelId: source.channelId, username: source.username,
      sourceTitle: source.channelName, messageId, publishedAt, editedAt,
      text: stripHtml(textHtml), sourceUrl, accessMethod: "TELEGRAM_PUBLIC_WEB"
    });
  }
  const unique = new Map(posts.map(post => [`${post.channelId || post.username}:${post.messageId}`, post]));
  return [...unique.values()];
}

function accessFromError(error) {
  if ([401, 403].includes(error?.status)) return TelegramReadAccess.BLOCKED;
  if (error?.status === 404) return TelegramReadAccess.PRIVATE;
  return TelegramReadAccess.BLOCKED;
}

export async function fetchPublicTelegramSources({
  sources = [], httpClient, cache, now = new Date(), ttlMinutes = 15, concurrency = 2
}) {
  const publicSources = sources.filter(source => source.enabled && source.username);
  const unresolvedResults = sources.filter(source => source.enabled && !source.username).map(source => providerResult({
    status: SourceStatus.NA, source: `context.telegram-public.${source.id}`, data: [],
    meta: { access: TelegramReadAccess.UNRESOLVED, accessMethod: "PUBLIC_WEB", url: null, postsRetrieved: 0, cacheHit: false, shadowOnly: true }
  }));
  const rows = await mapWithConcurrency(publicSources, concurrency, async source => {
    const username = String(source.username).replace(/^@/, "");
    const url = `https://t.me/s/${encodeURIComponent(username)}`;
    const cacheKey = `telegram-public:${username.toLowerCase()}`;
    let html = cache.get(cacheKey, ttlMinutes, now);
    let cacheHit = Boolean(html);
    try {
      if (!html) {
        html = await httpClient.fetchText(url, { retry: 0, userAgent: "FVM-Context/1.0 (public Telegram read-only)" });
        cache.set(cacheKey, html, now);
      }
      const posts = parseTelegramPublicPage(html, source);
      const access = posts.length ? TelegramReadAccess.READABLE_PUBLIC : TelegramReadAccess.BLOCKED;
      return { source, posts, result: providerResult({
        status: posts.length ? SourceStatus.OK : SourceStatus.NA,
        source: `context.telegram-public.${source.id}`, data: [],
        meta: { access, accessMethod: "PUBLIC_WEB", url, postsRetrieved: posts.length, cacheHit, shadowOnly: true }
      }) };
    } catch (error) {
      const access = accessFromError(error);
      return { source, posts: [], result: providerResult({
        status: SourceStatus.NA, source: `context.telegram-public.${source.id}`, data: [],
        meta: { access, accessMethod: "PUBLIC_WEB", url, postsRetrieved: 0, cacheHit, shadowOnly: true },
        error: { code: error.code || "ERROR", message: error.message }
      }) };
    }
  });
  return { posts: rows.flatMap(row => row.posts), providerResults: [...rows.map(row => row.result), ...unresolvedResults] };
}
