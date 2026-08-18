import fs from "node:fs";
import path from "node:path";
import { UI_TIME_ZONE } from "../config/constants.js";
import { healthLines } from "../diagnostics/sourceHealth.js";

export function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

function formatKyivDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: UI_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function mainKeyboard(state) {
  return keyboard([
    [
      { text: `VALUE (${state.value.length})`, callback_data: "list:value" },
      { text: `Near (${state.near.length})`, callback_data: "list:near" }
    ],
    [
      { text: `WAIT (${state.wait.length})`, callback_data: "list:wait" },
      { text: "Все матчи", callback_data: "list:fixtures" }
    ],
    [
      { text: "Pipeline", callback_data: "pipeline" },
      { text: "Обновить", callback_data: "refresh" }
    ]
  ]);
}

export function createTelegramUi({ config, tg, stateRef, refreshData }) {
  const deniedLog = path.join(config.root, "logs", "denied-access.log");

  function isAllowed(chatId) {
    return config.allowedChatIds.has(String(chatId));
  }

  function logDenied(update) {
    if (!config.logDeniedAccess) return;
    fs.mkdirSync(path.dirname(deniedLog), { recursive: true });
    const chat = update.message?.chat || update.callback_query?.message?.chat || {};
    const user = update.message?.from || update.callback_query?.from || {};
    fs.appendFileSync(
      deniedLog,
      JSON.stringify({
        time: new Date().toISOString(),
        chat_id: chat.id ?? null,
        username: user.username ?? null,
        input: update.message?.text ?? update.callback_query?.data ?? null
      }) + "\n",
      "utf8"
    );
  }

  function dashboardText() {
    const state = stateRef.current;
    const modelled = state.value.length + state.near.length + state.rejected.length;
    const oddsMode = config.oddsApiKey ? "реальные коэффициенты" : "без Odds API";

    return [
      "<b>FVM v1.0 CLEAN - REAL DATA</b>",
      "",
      state.loading ? "Статус: обновление" : "Статус: готово",
      `Обновлено: <b>${state.updatedAt ? formatKyivDate(state.updatedAt) : "еще нет"}</b>`,
      `Рынок: <b>${oddsMode}</b>`,
      "",
      `Матчей на ${config.horizonHours} часа: <b>${state.fixtures.length}</b>`,
      `С модельной оценкой: <b>${modelled}</b>`,
      `VALUE: <b>${state.value.length}</b>`,
      `Near Value: <b>${state.near.length}</b>`,
      `WAIT: <b>${state.wait.length}</b>`,
      `NO BET: <b>${state.rejected.length}</b>`,
      "",
      state.errors.length
        ? `Ошибок источников: <b>${state.errors.length}</b>`
        : "Источники: без критических ошибок",
      "",
      "<i>Это предварительное ядро 1X2. Полные xG, составы и Tactical Engine еще не подключены.</i>"
    ].join("\n");
  }

  async function sendDashboard(chatId, messageId = null) {
    const state = stateRef.current;
    const body = {
      chat_id: chatId,
      text: dashboardText(),
      parse_mode: "HTML",
      reply_markup: mainKeyboard(state)
    };

    if (messageId) {
      body.message_id = messageId;
      try {
        return await tg("editMessageText", body);
      } catch {
        delete body.message_id;
      }
    }
    return tg("sendMessage", body);
  }

  function statusText() {
    const state = stateRef.current;
    return [
      "<b>FVM status</b>",
      "",
      `Рабочая папка: <code>${esc(config.root)}</code>`,
      "Telegram token: <b>есть</b>",
      "Football-data token: <b>есть</b>",
      `Odds API: <b>${config.oddsApiKey ? "подключен" : "не подключен"}</b>`,
      `Allowed chat ids: <b>${config.allowedChatIds.size}</b>`,
      `Refresh: <b>${config.refreshMinutes} мин.</b>`,
      `Timeout: <b>${config.requestTimeoutSeconds} сек.</b>`,
      "",
      `Последнее обновление: <b>${state.updatedAt ? formatKyivDate(state.updatedAt) : "еще нет"}</b>`,
      `Матчей в кеше: <b>${state.fixtures.length}</b>`,
      `Ошибок источников: <b>${state.errors.length}</b>`,
      "",
      ...healthLines(state.sourceHealth),
      state.errors.length ? `\n<code>${esc(state.errors.slice(0, 5).join("\n"))}</code>` : ""
    ].join("\n");
  }

  function shortItem(item, index) {
    const time = formatKyivDate(item.utcDate);
    const detail = item.candidate
      ? `${item.candidate.side} @${item.candidate.odds} | Model ${(item.candidate.probability * 100).toFixed(0)}% | Edge ${item.candidate.edge.toFixed(1)}%`
      : item.reason;

    return `${index + 1}. <b>${esc(item.home)} - ${esc(item.away)}</b>\n${esc(item.competition)} · ${time}\n${esc(detail)}`;
  }

  async function showList(chatId, kind) {
    const state = stateRef.current;
    const map = {
      value: ["REAL VALUE", state.value],
      near: ["NEAR VALUE", state.near],
      wait: ["WAIT", state.wait],
      fixtures: [`Матчи на ${config.horizonHours} часа`, state.fixtures]
    };

    const [title, items] = map[kind] || map.fixtures;

    if (!items.length) {
      return tg("sendMessage", {
        chat_id: chatId,
        text: `<b>${title}</b>\n\nСписок пуст.`,
        parse_mode: "HTML",
        reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
      });
    }

    const shown = items.slice(0, 20);
    const text =
      `<b>${title}</b>\n\n` +
      shown.map(shortItem).join("\n\n") +
      (items.length > 20 ? `\n\nПоказано 20 из ${items.length}.` : "");

    const rows = shown.map(item => [{
      text: `${item.home.slice(0, 18)} - ${item.away.slice(0, 18)}`,
      callback_data: `card:${item.id}`
    }]);
    rows.push([{ text: "Dashboard", callback_data: "dashboard" }]);

    return tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard(rows)
    });
  }

  async function showCard(chatId, id) {
    const state = stateRef.current;
    const item = state.fixtures.find(x => x.id === id);
    if (!item) return;

    const lines = [
      `<b>${esc(item.home)} - ${esc(item.away)}</b>`,
      esc(item.competition),
      `Начало: ${formatKyivDate(item.utcDate)}`,
      "",
      `Статус: <b>${item.category.toUpperCase()}</b>`,
      `Data Quality: <b>${item.dataQuality}/100</b>`
    ];

    if (item.model) {
      lines.push(
        "",
        "Модель 1X2:",
        `П1 ${(item.model.home * 100).toFixed(1)}% · X ${(item.model.draw * 100).toFixed(1)}% · П2 ${(item.model.away * 100).toFixed(1)}%`,
        `Ожидаемая результативность: ${item.model.expectedGoals.toFixed(2)}`
      );
    }

    if (item.candidate) {
      const c = item.candidate;
      lines.push(
        "",
        `Лучший рынок: <b>${c.side}</b>`,
        `Коэффициент: <b>${c.odds}</b> (${esc(item.bookmaker)})`,
        `Model: <b>${(c.probability * 100).toFixed(1)}%</b>`,
        `Fair Odds: <b>${c.fairOdds.toFixed(2)}</b>`,
        `Edge: <b>${c.edge.toFixed(1)} п.п.</b>`,
        `EV: <b>${c.ev.toFixed(1)}%</b>`,
        `Confidence: <b>${item.confidence}/100</b>`
      );
    }

    if (item.reason) lines.push("", `Причина: ${esc(item.reason)}`);

    lines.push(
      "",
      "<i>Предварительная версия модели. Не является гарантией результата.</i>"
    );

    return tg("sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
    });
  }

  async function handleCallback(query) {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    if (!isAllowed(chatId)) {
      logDenied({ callback_query: query });
      await tg("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Доступ закрыт.",
        show_alert: false
      }).catch(() => {});
      return;
    }

    await tg("answerCallbackQuery", { callback_query_id: query.id });

    if (query.data === "dashboard") return sendDashboard(chatId, query.message.message_id);
    if (query.data === "refresh") {
      await refreshData();
      return sendDashboard(chatId, query.message.message_id);
    }
    if (query.data === "pipeline") {
      return tg("sendMessage", {
        chat_id: chatId,
        text: [
          "<b>Pipeline v1.0 CLEAN</b>",
          "",
          "Готово: реальное расписание",
          "Готово: таблицы и последние результаты",
          "Готово: предварительная модель 1X2",
          config.oddsApiKey ? "Готово: реальные коэффициенты" : "WAIT: Odds API не подключен",
          "Готово: удаление маржи",
          "Готово: VALUE / Near / WAIT / NO BET",
          "Готово: source health",
          "Готово: накопительная история",
          "Дальше: xG Model, Squad/Injuries, Tactical/SCI/MAI"
        ].join("\n"),
        parse_mode: "HTML",
        reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
      });
    }
    if (query.data.startsWith("list:")) return showList(chatId, query.data.split(":")[1]);
    if (query.data.startsWith("card:")) return showCard(chatId, query.data.split(":")[1]);
  }

  async function handleMessage(message) {
    const chatId = message.chat.id;

    if (!isAllowed(chatId)) {
      logDenied({ message });
      return tg("sendMessage", {
        chat_id: chatId,
        text: "Доступ закрыт."
      }).catch(() => {});
    }

    const text = message.text?.trim().toLowerCase();
    if (text === "/start" || text === "/dashboard") return sendDashboard(chatId);
    if (text === "/refresh") {
      await tg("sendMessage", { chat_id: chatId, text: "Обновляю реальные данные..." });
      await refreshData();
      return sendDashboard(chatId);
    }
    if (text === "/status") {
      return tg("sendMessage", {
        chat_id: chatId,
        text: statusText(),
        parse_mode: "HTML"
      });
    }
    if (text === "/id") {
      return tg("sendMessage", {
        chat_id: chatId,
        text: `Ваш chat_id: <code>${chatId}</code>`,
        parse_mode: "HTML"
      });
    }
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Команды:\n/start\n/dashboard\n/refresh\n/status\n/id"
    });
  }

  return { handleMessage, handleCallback, sendDashboard, statusText };
}
