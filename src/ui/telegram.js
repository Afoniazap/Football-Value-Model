import fs from "node:fs";
import path from "node:path";
import { healthLines } from "../diagnostics/sourceHealth.js";
import { summarizeLatestTelemetry } from "../diagnostics/refreshTelemetry.js";
import { UI_LABELS } from "./labels.js";
import { formatKyivDateLabel } from "./time.js";

export function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

function mainKeyboard(state) {
  return keyboard([
    [
      { text: `${UI_LABELS.value} (${state.value.length})`, callback_data: "list:value" },
      { text: `${UI_LABELS.near} (${state.near.length})`, callback_data: "list:near" }
    ],
    [
      { text: `${UI_LABELS.wait} (${state.wait.length})`, callback_data: "list:wait" },
      { text: `${UI_LABELS.noBet} (${state.rejected.length})`, callback_data: "list:rejected" }
    ],
    [
      { text: UI_LABELS.sources, callback_data: "sources_overview" },
      { text: UI_LABELS.whyNoValue, callback_data: "blockers" }
    ],
    [
      { text: UI_LABELS.statistics, callback_data: "stats" },
      { text: "Shadow", callback_data: "shadow_stats" }
    ],
    [
      { text: "Pipeline", callback_data: "pipeline" },
      { text: "Обновить", callback_data: "refresh" }
    ]
  ]);
}

function percent(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function ratioLine(label, row) {
  return row ? `${label}: <b>${row.numerator}/${row.denominator}</b> (${row.percent}%)` : `${label}: N/A`;
}

export function createTelegramUi({
  config,
  tg,
  stateRef,
  refreshData,
  shadowStats = null,
  auditStats = null,
  dailyAudit = null
}) {
  const deniedLog = path.join(config.root, "logs", "denied-access.log");

  function isAllowed(chatId) {
    return config.allowedChatIds.has(String(chatId));
  }

  function logDenied(update) {
    if (!config.logDeniedAccess) return;
    fs.mkdirSync(path.dirname(deniedLog), { recursive: true });
    const chat = update.message?.chat || update.callback_query?.message?.chat || {};
    const user = update.message?.from || update.callback_query?.from || {};
    fs.appendFileSync(deniedLog, JSON.stringify({
      time: new Date().toISOString(),
      chat_id: chat.id ?? null,
      username: user.username ?? null,
      input: update.message?.text ?? update.callback_query?.data ?? null
    }) + "\n", "utf8");
  }

  function dashboardText() {
    const state = stateRef.current;
    const telemetry = state.telemetry || null;
    const summary = telemetry ? summarizeLatestTelemetry(telemetry, config) : null;
    const system = state.loading
      ? "REFRESHING"
      : state.systemReadiness?.status || summary?.system?.status || "DEGRADED";
    const audit = typeof auditStats === "function" ? auditStats() : null;
    const shadow = typeof shadowStats === "function" ? shadowStats() : null;

    if (!telemetry) {
      return [
        "<b>FVM v1.0 CLEAN</b>",
        "",
        `System: <b>${esc(system)}</b>`,
        `${UI_LABELS.updated}: <b>${state.updatedAt ? formatKyivDateLabel(state.updatedAt) : "ещё нет"}</b>`,
        "",
        `Matches: <b>${state.fixtures.length}</b>`,
        `${UI_LABELS.value}: <b>${state.value.length}</b>`,
        `${UI_LABELS.near}: <b>${state.near.length}</b>`,
        `${UI_LABELS.wait}: <b>${state.wait.length}</b>`,
        `${UI_LABELS.noBet}: <b>${state.rejected.length}</b>`
      ].join("\n");
    }

    return [
      "<b>FVM v1.0 CLEAN</b>",
      "",
      `System: <b>${esc(system)}</b>`,
      `${UI_LABELS.updated}: <b>${formatKyivDateLabel(telemetry.finishedAt)}</b>`,
      "",
      "24h:",
      `Matches <b>${telemetry.fixturesInsideExactHorizon}</b>`,
      `Markets <b>${telemetry.coverage.market.numerator}/${telemetry.coverage.market.denominator}</b> (${telemetry.coverage.market.percent}%)`,
      `Market competitions <b>${telemetry.competitionCoverage.supported}/${telemetry.competitionCoverage.total}</b> supported`,
      telemetry.competitionCoverage.unsupportedTop.length
        ? `Unsupported <b>${esc(telemetry.competitionCoverage.unsupportedTop.map(row => `${row.code} ${row.count}`).join(", "))}</b>`
        : "Unsupported <b>none</b>",
      "",
      `${UI_LABELS.value} <b>${telemetry.categories.VALUE}</b>`,
      `${UI_LABELS.near} <b>${telemetry.categories.NEAR}</b>`,
      `${UI_LABELS.wait} <b>${telemetry.categories.WAIT}</b>`,
      `${UI_LABELS.noBet} <b>${telemetry.categories.NO_BET}</b>`,
      "",
      "Data:",
      `DQ avg <b>${telemetry.dqDistribution.average ?? "N/A"}</b>`,
      `Market <b>${telemetry.coverage.market.percent}%</b>`,
      `API-Football <b>${telemetry.coverage.apiFootball.numerator}/${telemetry.coverage.apiFootball.denominator}</b>`,
      `Lineups <b>${telemetry.coverage.lineups.numerator}/${telemetry.coverage.lineups.denominator}</b>`,
      `xG <b>${esc(telemetry.coverage.xg.status)}</b>`,
      "",
      "Sources:",
      `FD <b>${esc(state.sourceHealth?.["football-data.fixtures"]?.status || "N/A")}</b>`,
      `Odds Primary <b>${esc(Object.entries(state.sourceHealth || {}).find(([source]) => source.startsWith("odds."))?.[1]?.status || "N/A")}</b>`,
      `Odds Secondary <b>${esc(state.sourceHealth?.["odds-api-io"]?.status || state.sourceHealth?.["odds.secondary"]?.status || "N/A")}</b>`,
      `API-Football <b>${esc(state.sourceHealth?.["api-football"]?.status || "N/A")}</b>`,
      `xG <b>${esc(state.sourceHealth?.xg?.status || "N/A")}</b>`,
      "",
      "Audit:",
      `Bets <b>${audit?.overall?.officialBets ?? 0}</b>`,
      `ROI <b>${percent(audit?.overall?.roi)}</b>`,
      `Shadow <b>${shadow?.sampleSize ?? 0}/300</b>`
    ].join("\n");
  }

  async function sendDashboard(chatId, messageId = null) {
    const body = {
      chat_id: chatId,
      text: dashboardText(),
      parse_mode: "HTML",
      reply_markup: mainKeyboard(stateRef.current)
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
      `System: <b>${esc(state.systemReadiness?.status || "DEGRADED")}</b>`,
      `Allowed chat IDs: <b>${config.allowedChatIds.size}</b>`,
      `Refresh: <b>${config.refreshMinutes} мин.</b>`,
      `Horizon: <b>${config.horizonHours} ч.</b>`,
      "",
      `${UI_LABELS.updated}: <b>${state.updatedAt ? formatKyivDateLabel(state.updatedAt) : "ещё нет"}</b>`,
      `Ошибок источников: <b>${state.errors.length}</b>`,
      "",
      ...healthLines(state.sourceHealth),
      state.errors.length ? `\n<code>${esc(state.errors.slice(0, 5).join("\n"))}</code>` : ""
    ].join("\n");
  }

  function listItems(kind) {
    const state = stateRef.current;
    const map = {
      value: [UI_LABELS.value, state.value],
      near: [UI_LABELS.near, state.near],
      wait: [UI_LABELS.wait, state.wait],
      rejected: [UI_LABELS.noBet, state.rejected],
      fixtures: [`Матчи на ${config.horizonHours} часов`, state.fixtures]
    };
    return map[kind] || map.fixtures;
  }

  function shortItem(item, index) {
    const detail = item.candidate
      ? `${item.candidate.side} @${item.candidate.odds} | Model ${(item.candidate.probability * 100).toFixed(1)}% | Edge ${item.candidate.edge.toFixed(1)}%`
      : item.reason || item.diagnostics?.market?.reason || "Нет решения";
    return `${index + 1}. <b>${esc(item.home)} - ${esc(item.away)}</b>\n${esc(item.competition)} | ${formatKyivDateLabel(item.utcDate)}\n${esc(detail)}`;
  }

  async function showList(chatId, kind) {
    const [title, items] = listItems(kind);
    if (!items.length) {
      return tg("sendMessage", {
        chat_id: chatId,
        text: `<b>${esc(title)}</b>\n\nСписок пуст.`,
        parse_mode: "HTML",
        reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
      });
    }
    const shown = items.slice(0, 20);
    const rows = shown.map(item => [{
      text: `${item.home.slice(0, 18)} - ${item.away.slice(0, 18)}`,
      callback_data: `card:${item.id}`
    }]);
    rows.push([{ text: "Dashboard", callback_data: "dashboard" }]);
    return tg("sendMessage", {
      chat_id: chatId,
      text: [`<b>${esc(title)}</b>`, "", ...shown.map(shortItem)].join("\n\n"),
      parse_mode: "HTML",
      reply_markup: keyboard(rows)
    });
  }

  function findItem(id) {
    return stateRef.current.fixtures.find(item => item.id === id);
  }

  async function showDiagnostics(chatId, id, kind) {
    const item = findItem(id);
    if (!item) return;
    const d = item.diagnostics || {};
    let title = "Diagnostics";
    let lines = [];

    if (kind === "dq") {
      title = "Data Quality";
      const dq = d.dataQualityV2;
      lines = dq ? [
        `DQ: <b>${dq.scoreNormalized}/100</b>`,
        `Raw: <b>${dq.rawScore}/${dq.availableMax}</b>`,
        "",
        ...dq.components.map(part => `${esc(part.name)}: <b>${part.score}/${part.max}</b> (${esc(part.status)})${part.note ? ` - ${esc(part.note)}` : ""}`)
      ] : ["Нет данных DQ."];
    }

    if (kind === "risk") {
      title = UI_LABELS.risks;
      const risk = d.risk;
      lines = risk ? [
        `Risk: <b>${risk.score}/100</b>`,
        `Model Agreement: <b>${risk.modelAgreement}/100</b>`,
        "",
        ...(risk.redFlags?.length ? risk.redFlags.map(flag => `${esc(flag.severity)} ${esc(flag.code)}: ${esc(flag.message)}`) : ["Red flags нет."])
      ] : ["Нет данных Risk."];
    }

    if (kind === "sources") {
      title = UI_LABELS.sources;
      lines = Object.entries(d.providerHealth || stateRef.current.sourceHealth || {})
        .map(([source, health]) => `${esc(source)}: <b>${esc(health.status)}</b>${health.meta?.reason ? ` | ${esc(health.meta.reason)}` : ""}`);
      if (!lines.length) lines = ["Нет данных источников."];
    }

    if (kind === "sanity") {
      title = "Sanity";
      const warnings = d.sanityWarnings || [];
      lines = warnings.length
        ? warnings.map(warning => `${esc(warning.code)} / ${esc(warning.reason)}: ${esc(warning.message)}`)
        : ["Sanity warnings нет."];
    }

    if (kind === "shadow") {
      title = "Shadow";
      const shadow = item.shadow;
      lines = shadow?.shadowStatus === "OK"
        ? [
            "OFFICIAL = <b>BASELINE</b>",
            `Agreement: <b>${esc(shadow.disagreementStatus)}</b>`,
            `Baseline category: <b>${esc(shadow.baseline.category)}</b>`,
            `Challenger shadow category: <b>${esc(shadow.challenger.shadowCategory)}</b>`
          ]
        : [`shadowStatus: <b>${esc(shadow?.shadowStatus || "N/A")}</b>`, esc(shadow?.reason || "No challenger probability.")];
    }

    return tg("sendMessage", {
      chat_id: chatId,
      text: [`<b>${title}</b>`, "", `<b>${esc(item.home)} - ${esc(item.away)}</b>`, "", ...lines].join("\n"),
      parse_mode: "HTML",
      reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
    });
  }

  async function showCard(chatId, id) {
    const item = findItem(id);
    if (!item) return;
    const dq = item.diagnostics?.dataQualityV2;
    const risk = item.diagnostics?.risk;
    const lines = [
      `<b>${esc(item.home)} - ${esc(item.away)}</b>`,
      esc(item.competition),
      `Kickoff: ${formatKyivDateLabel(item.utcDate)}`,
      "",
      "MODEL:",
      item.model
        ? `Baseline P1 ${(item.model.home * 100).toFixed(1)}% / X ${(item.model.draw * 100).toFixed(1)}% / P2 ${(item.model.away * 100).toFixed(1)}%`
        : "Baseline: N/A",
      item.shadow?.challenger?.probabilities
        ? `Challenger P1 ${(item.shadow.challenger.probabilities.home * 100).toFixed(1)}% / X ${(item.shadow.challenger.probabilities.draw * 100).toFixed(1)}% / P2 ${(item.shadow.challenger.probabilities.away * 100).toFixed(1)}%`
        : "Challenger: N/A",
      "",
      "MARKET:",
      `source <b>${esc(item.diagnostics?.market?.source || "N/A")}</b>`,
      `bookmaker <b>${esc(item.bookmaker || "N/A")}</b>`,
      item.candidate ? `odds <b>${item.candidate.odds}</b> | fair <b>${item.candidate.fairOdds.toFixed(2)}</b>` : "odds N/A",
      `freshness <b>${esc(item.diagnostics?.market?.freshness || "N/A")}</b>`,
      "",
      "DATA QUALITY:",
      dq ? `score <b>${dq.scoreNormalized}/100</b>` : "score N/A",
      dq ? `missing <b>${esc(dq.components.filter(part => part.score < part.max).slice(0, 3).map(part => part.name).join(", ") || "none")}</b>` : "",
      "",
      "RISK:",
      risk ? `score <b>${risk.score}/100</b>` : "score N/A",
      risk ? `flags <b>${esc((risk.redFlags || []).slice(0, 3).map(flag => flag.code).join(", ") || "none")}</b>` : "",
      "",
      "DECISION:",
      `official category <b>${esc(item.category.toUpperCase())}</b>`,
      item.reason ? `failed gates <b>${esc(item.reason)}</b>` : "failed gates <b>none</b>"
    ].filter(Boolean);

    return tg("sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      reply_markup: keyboard([
        [
          { text: "DQ", callback_data: `dq:${item.id}` },
          { text: UI_LABELS.risks, callback_data: `risk:${item.id}` }
        ],
        [
          { text: UI_LABELS.sources, callback_data: `sources:${item.id}` },
          { text: "Sanity", callback_data: `sanity:${item.id}` }
        ],
        [{ text: "Shadow", callback_data: `shadow:${item.id}` }],
        [{ text: "Dashboard", callback_data: "dashboard" }]
      ])
    });
  }

  async function showAuditScreen(chatId, kind) {
    const audit = typeof auditStats === "function" ? auditStats() : null;
    const daily = typeof dailyAudit === "function" ? dailyAudit() : null;
    const shadow = typeof shadowStats === "function" ? shadowStats() : null;
    const telemetry = stateRef.current.telemetry;
    let title = UI_LABELS.statistics;
    let lines = [];

    if (kind === "stats") {
      lines = audit ? [
        `Official bets: <b>${audit.overall.officialBets}</b>`,
        `Settled: <b>${audit.overall.settledBets}</b>`,
        `W-L-P: <b>${audit.overall.win}-${audit.overall.loss}-${audit.overall.push}</b>`,
        `Units: <b>${audit.overall.netUnits.toFixed(2)}</b>`,
        `ROI: <b>${percent(audit.overall.roi)}</b>`
      ] : ["No audit data."];
    }

    if (kind === "daily") {
      title = "Daily Audit";
      lines = daily ? [
        `Date ${UI_LABELS.kyiv}: <b>${esc(daily.dateKyiv)}</b>`,
        `Issued: <b>${daily.officialValueIssued}</b>`,
        `Settled: <b>${daily.settled}</b>`,
        `Pending: <b>${daily.pending}</b>`,
        `Units: <b>${daily.betting.netUnits.toFixed(2)}</b>`,
        `ROI: <b>${percent(daily.betting.roi)}</b>`
      ] : ["No daily audit data."];
    }

    if (kind === "sources") {
      title = UI_LABELS.sources;
      const coverage = telemetry?.coverage || {};
      lines = [
        ...healthLines(stateRef.current.sourceHealth),
        "",
        ratioLine("Market", coverage.market),
        ratioLine("API-Football", coverage.apiFootball),
        ratioLine("Injuries", coverage.injuries),
        ratioLine("Lineups", coverage.lineups),
        coverage.xg ? `xG: <b>${coverage.xg.numerator}/${coverage.xg.denominator}</b> (${esc(coverage.xg.status)})` : "xG: N/A",
        "",
        ...(telemetry?.competitionCoverage?.rows || []).map(row => `${esc(row.code)}: <b>${row.count}</b> ${esc(row.support)}`)
      ];
    }

    if (kind === "blockers") {
      title = UI_LABELS.whyNoValue;
      const blockers = telemetry?.blockers?.top || [];
      lines = blockers.length ? blockers.map(row => `${esc(row.reason)}: <b>${row.count}</b>`) : ["No blockers recorded."];
    }

    if (kind === "shadow_stats") {
      title = "Shadow";
      lines = shadow ? [
        `Sample: <b>${shadow.sampleSize}/300</b>`,
        `Baseline Brier: <b>${shadow.baseline.brier?.toFixed?.(4) ?? "N/A"}</b>`,
        `Challenger Brier: <b>${shadow.challenger.brier?.toFixed?.(4) ?? "N/A"}</b>`,
        `Strong disagreement: <b>${shadow.strongDisagreementCount}</b>`
      ] : ["No shadow stats."];
    }

    return tg("sendMessage", {
      chat_id: chatId,
      text: [`<b>${title}</b>`, "", ...lines].join("\n"),
      parse_mode: "HTML",
      reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
    });
  }

  async function handleCallback(query) {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;
    if (!isAllowed(chatId)) {
      logDenied({ callback_query: query });
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Доступ закрыт.", show_alert: false }).catch(() => {});
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: query.id });

    if (query.data === "dashboard") return sendDashboard(chatId, query.message.message_id);
    if (query.data === "stats") return showAuditScreen(chatId, "stats");
    if (query.data === "daily_audit") return showAuditScreen(chatId, "daily");
    if (query.data === "sources_overview") return showAuditScreen(chatId, "sources");
    if (query.data === "blockers") return showAuditScreen(chatId, "blockers");
    if (query.data === "shadow_stats") return showAuditScreen(chatId, "shadow_stats");
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
          "Готово: real fixtures",
          "Готово: exact 24h horizon",
          "Готово: baseline 1X2 model",
          "Готово: market fallback diagnostics",
          "Готово: source health",
          "Готово: refresh telemetry",
          "Готово: doctor integrity checks",
          "xG: diagnostic-only"
        ].join("\n"),
        parse_mode: "HTML",
        reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
      });
    }
    if (query.data.startsWith("list:")) return showList(chatId, query.data.split(":")[1]);
    if (query.data.startsWith("card:")) return showCard(chatId, query.data.split(":")[1]);
    if (query.data.startsWith("dq:")) return showDiagnostics(chatId, query.data.split(":")[1], "dq");
    if (query.data.startsWith("risk:")) return showDiagnostics(chatId, query.data.split(":")[1], "risk");
    if (query.data.startsWith("sources:")) return showDiagnostics(chatId, query.data.split(":")[1], "sources");
    if (query.data.startsWith("sanity:")) return showDiagnostics(chatId, query.data.split(":")[1], "sanity");
    if (query.data.startsWith("shadow:")) return showDiagnostics(chatId, query.data.split(":")[1], "shadow");
  }

  async function handleMessage(message) {
    const chatId = message.chat.id;
    if (!isAllowed(chatId)) {
      logDenied({ message });
      return tg("sendMessage", { chat_id: chatId, text: "Доступ закрыт." }).catch(() => {});
    }
    const text = message.text?.trim().toLowerCase();
    if (text === "/start" || text === "/dashboard") return sendDashboard(chatId);
    if (text === "/refresh") {
      await tg("sendMessage", { chat_id: chatId, text: "Обновляю реальные данные..." });
      await refreshData();
      return sendDashboard(chatId);
    }
    if (text === "/status") return tg("sendMessage", { chat_id: chatId, text: statusText(), parse_mode: "HTML" });
    if (text === "/id") return tg("sendMessage", { chat_id: chatId, text: `Ваш chat_id: <code>${chatId}</code>`, parse_mode: "HTML" });
    return tg("sendMessage", { chat_id: chatId, text: "Команды:\n/start\n/dashboard\n/refresh\n/status\n/id" });
  }

  return { handleMessage, handleCallback, sendDashboard, statusText };
}
