export const TelegramAuthStatus = Object.freeze({
  VALID: "VALID", UNAUTHORIZED: "UNAUTHORIZED", NETWORK_ERROR: "NETWORK_ERROR",
  API_ERROR: "API_ERROR", MISSING_TOKEN: "MISSING_TOKEN"
});

export function telegramTokenAudit(token) {
  const value = String(token || "").trim();
  return { present: Boolean(value), formatPlausible: /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(value), configSource: "TELEGRAM_BOT_TOKEN via dotenv" };
}

export function createTelegramClient({ token, request }) {
  const audit = telegramTokenAudit(token);
  const api = audit.present ? `https://api.telegram.org/bot${String(token).trim()}` : null;
  async function call(method, body = {}) {
    if (!api) throw Object.assign(new Error("Telegram token missing"), { code: "MISSING_TOKEN" });
    const data = await request(`${api}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    if (!data.ok) throw Object.assign(new Error(`${method}: ${data.description}`), { code: data.error_code === 401 ? "UNAUTHORIZED" : "API_ERROR" });
    return data.result;
  }
  return { audit, call, getMe: () => call("getMe"), getChat: identifier => call("getChat", { chat_id: identifier }), getChatMember: (chatId, userId) => call("getChatMember", { chat_id: chatId, user_id: userId }) };
}

export async function validateTelegramBot(client) {
  if (!client.audit.present) return { status: TelegramAuthStatus.MISSING_TOKEN, bot: null };
  try {
    const bot = await client.getMe();
    return { status: TelegramAuthStatus.VALID, bot: { id: bot.id, username: bot.username ? `@${bot.username}` : null } };
  } catch (error) {
    if (error.code === "UNAUTHORIZED" || /unauthorized/i.test(error.message)) return { status: TelegramAuthStatus.UNAUTHORIZED, bot: null };
    if (error.code === "API_ERROR") return { status: TelegramAuthStatus.API_ERROR, bot: null };
    return { status: TelegramAuthStatus.NETWORK_ERROR, bot: null };
  }
}
