import { matchTelegramMetadata, mergeResolvedTelegramMetadata } from "./telegramRegistry.js";

function accessError(error) {
  const message = String(error?.message || error || "ERROR");
  if (/unauthorized/i.test(message)) return "AUTH";
  if (/private|not found|chat not found|forbidden/i.test(message)) return "INACCESSIBLE_OR_PRIVATE";
  return "ERROR";
}

export async function resolveTelegramIdentifiers({ identifiers = [], registry = [], getChat }) {
  const results = [];
  for (const identifier of identifiers) {
    try {
      const chat = await getChat(identifier.value);
      const metadata = {
        requestedIdentifier: identifier.value,
        channelId: chat.id, username: chat.username ? `@${chat.username}` : null,
        title: chat.title || null, chatType: chat.type || null, accessibility: "ACCESSIBLE"
      };
      const source = matchTelegramMetadata(metadata, registry);
      results.push({ ...metadata, sourceId: source?.id || null, resolutionStatus: source ? "RESOLVED" : "UNRESOLVED" });
    } catch (error) {
      results.push({ requestedIdentifier: identifier.value, sourceId: null, resolutionStatus: "UNRESOLVED", failure: accessError(error) });
    }
  }
  return { results, registry: mergeResolvedTelegramMetadata(registry, results.filter(item => item.sourceId)) };
}
