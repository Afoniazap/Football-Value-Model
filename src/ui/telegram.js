import fs from "node:fs";
import path from "node:path";
import { healthLines } from "../diagnostics/sourceHealth.js";
import { summarizeLatestTelemetry } from "../diagnostics/refreshTelemetry.js";
import { formatKyivDate } from "./time.js";
import { UI_LABELS } from "./labels.js";

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
      { text: "Все матчи", callback_data: "list:fixtures" }
    ],
    [
      { text: "Pipeline", callback_data: "pipeline" },
      { text: "Обновить", callback_data: "refresh" }
    ],
    [
      { text: UI_LABELS.statistics, callback_data: "stats" },
      { text: UI_LABELS.sources, callback_data: "sources_overview" }
    ],
    [
      { text: UI_LABELS.whyNoValue, callback_data: "blockers" },
      { text: "Shadow", callback_data: "shadow_stats" }
    ]
  ]);
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
    const telemetry = state.telemetry || null;
    const system = state.systemReadiness?.status ||
      (telemetry ? summarizeLatestTelemetry(telemetry, config).system.status : "DEGRADED");
    if (telemetry) {
      const audit = typeof auditStats === "function" ? auditStats() : null;
      const shadow = typeof shadowStats === "function" ? shadowStats() : null;
      return [
        "<b>FVM v1.0 CLEAN</b>",
        "",
        state.loading ? "System: <b>REFRESHING</b>" : `System: <b>${esc(system)}</b>`,
        `Updated: <b>${formatKyivDate(telemetry.finishedAt)}</b>`,
        "",
        "24h:",
        `Matches <b>${telemetry.fixturesInsideExactHorizon}</b>`,
        `Markets <b>${telemetry.coverage.market.numerator}/${telemetry.coverage.market.denominator}</b> (${telemetry.coverage.market.percent}%)`,
        `Market competitions <b>${telemetry.competitionCoverage.supported}/${telemetry.competitionCoverage.total}</b> supported`,
        telemetry.competitionCoverage.unsupportedTop.length
          ? `Unsupported <b>${esc(telemetry.competitionCoverage.unsupportedTop.map(row => `${row.code} ${row.count}`).join(", "))}</b>`
          : "Unsupported <b>none</b>",
        "",
        `VALUE <b>${telemetry.categories.VALUE}</b>`,
        `NEAR <b>${telemetry.categories.NEAR}</b>`,
        `WAIT <b>${telemetry.categories.WAIT}</b>`,
        `NO BET <b>${telemetry.categories.NO_BET}</b>`,
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
        `Odds Primary <b>${esc(Object.entries(state.sourceHealth || {}).find(([source]) => source.startsWith("odds.") && source !== "odds.secondary" && source !== "odds-api-io")?.[1]?.status || "N/A")}</b>`,
        `Odds Secondary <b>${esc(state.sourceHealth?.["odds-api-io"]?.status || state.sourceHealth?.["odds.secondary"]?.status || "N/A")}</b>`,
        `API-Football <b>${esc(state.sourceHealth?.["api-football"]?.status || "N/A")}</b>`,
        `xG <b>${esc(state.sourceHealth?.xg?.status || "N/A")}</b>`,
        "",
        "Audit:",
        `Bets <b>${audit?.overall?.officialBets ?? 0}</b>`,
        `ROI <b>${audit?.overall?.roi === null || audit?.overall?.roi === undefined ? "N/A" : `${(audit.overall.roi * 100).toFixed(1)}%`}</b>`,
        `Shadow <b>${shadow?.sampleSize ?? 0}/300</b>`
      ].join("\n");
    }
    const modelled = state.value.length + state.near.length + state.rejected.length;
    const shadow = typeof shadowStats === "function" ? shadowStats() : null;
    const audit = typeof auditStats === "function" ? auditStats() : null;
    const shadowLines = shadow
      ? [
          "",
          `🧪 Shadow sample: <b>${shadow.sampleSize}</b>`,
          shadow.sampleSize < 300
            ? "Shadow: <b>insufficient sample</b>"
            : `Baseline Brier: <b>${shadow.baseline.brier?.toFixed?.(4) ?? "N/A"}</b>`,
          shadow.sampleSize >= 300
            ? `Challenger Brier: <b>${shadow.challenger.brier?.toFixed?.(4) ?? "N/A"}</b>`
            : "",
          shadow.sampleSize
            ? `Agreement: <b>${((shadow.topPickAgreementRate || 0) * 100).toFixed(1)}%</b>`
            : "Agreement: <b>N/A</b>"
        ].filter(Boolean)
      : [];
    const auditLines = audit
      ? [
          "",
          "Official Audit:",
          `Bets: <b>${audit.overall.officialBets}</b>`,
          `Settled: <b>${audit.overall.settledBets}</b>`,
          `W-L-P: <b>${audit.overall.win}-${audit.overall.loss}-${audit.overall.push}</b>`,
          `Units: <b>${audit.overall.netUnits.toFixed(2)}</b>`,
          `ROI: <b>${audit.overall.roi === null ? "N/A" : `${(audit.overall.roi * 100).toFixed(1)}%`}</b>`
        ]
      : [];
    const marketCache = state.sourceHealth?.["market.cache"]?.meta || {};
    const primaryOdds = Object.entries(state.sourceHealth || {})
      .find(([source]) => source.startsWith("odds.") && source !== "odds.secondary")?.[1];
    const marketLines = [
      "",
      "Market:",
      `Primary <b>${esc(primaryOdds?.status || "N/A")}</b>`,
      `Cache FRESH <b>${marketCache.fresh || 0}</b>`,
      `STALE <b>${marketCache.stale || 0}</b>`,
      `EXPIRED <b>${marketCache.expired || 0}</b>`
    ];
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
      ...auditLines,
      ...marketLines,
      ...shadowLines,
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

  function findItem(id) {
    return stateRef.current.fixtures.find(x => x.id === id);
  }

  async function showDiagnostics(chatId, id, kind) {
    const item = findItem(id);
    if (!item) return;

    const diagnostics = item.diagnostics || {};
    let title = "Diagnostics";
    let lines = [];

    if (kind === "dq") {
      const dq = diagnostics.dataQualityV2;
      title = "Data Quality";
      lines = dq ? [
        `DQ: <b>${dq.scoreNormalized}/100</b>`,
        `Raw: <b>${dq.rawScore}/${dq.availableMax}</b>`,
        "",
        ...dq.components.map(part =>
          `${esc(part.name)}: <b>${part.score}/${part.max}</b> (${esc(part.status)})${part.note ? ` - ${esc(part.note)}` : ""}`
        )
      ] : ["Нет данных DQ."];
    }

    if (kind === "risk") {
      const risk = diagnostics.risk;
      title = "Risk";
      lines = risk ? [
        `Risk: <b>${risk.score}/100</b>`,
        `Model Agreement: <b>${risk.modelAgreement}/100</b>`,
        "",
        ...(risk.redFlags.length
          ? risk.redFlags.map(flag => `${esc(flag.severity)} ${esc(flag.code)}: ${esc(flag.message)}`)
          : ["Red flags нет."])
      ] : ["Нет данных Risk."];
    }

    if (kind === "sources") {
      title = "Sources";
      const providerHealth = diagnostics.providerHealth || stateRef.current.sourceHealth || {};
      lines = Object.entries(providerHealth).map(([source, health]) =>
        `${esc(source)}: <b>${esc(health.status)}</b>` +
        `${health.coverageCount !== null && health.coverageCount !== undefined ? ` | coverage ${health.coverageCount}` : ""}` +
        `${health.meta?.reason ? ` | ${esc(health.meta.reason)}` : ""}`
      );
      if (!lines.length) lines = ["Нет данных источников."];
    }

    if (kind === "sanity") {
      title = "Sanity";
      const warnings = diagnostics.sanityWarnings || [];
      lines = warnings.length
        ? warnings.map(warning => `${esc(warning.code)} / ${esc(warning.reason)}: ${esc(warning.message)}`)
        : ["Sanity warnings нет."];
    }

    if (kind === "shadow") {
      title = "Shadow";
      const shadow = item.shadow;
      if (!shadow || shadow.shadowStatus !== "OK") {
        lines = [
          `shadowStatus: <b>${esc(shadow?.shadowStatus || "N/A")}</b>`,
          esc(shadow?.reason || "No challenger probability.")
        ];
      } else {
        const bp = shadow.baseline.probabilities;
        const cp = shadow.challenger.probabilities;
        const d = shadow.differences;
        const bm = shadow.baseline.market.selected;
        const cm = shadow.challenger.market.selected;
        lines = [
          "OFFICIAL = <b>BASELINE</b>",
          `shadowStatus: <b>${esc(shadow.shadowStatus)}</b>`,
          "",
          "Baseline:",
          `P1 ${(bp.home * 100).toFixed(1)}% / X ${(bp.draw * 100).toFixed(1)}% / P2 ${(bp.away * 100).toFixed(1)}%`,
          "Challenger:",
          `P1 ${(cp.home * 100).toFixed(1)}% / X ${(cp.draw * 100).toFixed(1)}% / P2 ${(cp.away * 100).toFixed(1)}%`,
          "Difference:",
          `P1 ${((cp.home - bp.home) * 100).toFixed(1)} pp / X ${((cp.draw - bp.draw) * 100).toFixed(1)} pp / P2 ${((cp.away - bp.away) * 100).toFixed(1)} pp`,
          "",
          `Top picks: Baseline ${esc(shadow.baseline.topPick?.side || "N/A")} / Challenger ${esc(shadow.challenger.topPick?.side || "N/A")}`,
          `Agreement: <b>${esc(shadow.disagreementStatus)}</b> (${(d.maxProbabilityDifference * 100).toFixed(1)} pp)`,
          "",
          "Market:",
          bm
            ? `Baseline ${esc(bm.side)} Edge ${bm.edge.toFixed(1)} pp / EV ${bm.ev.toFixed(1)}%`
            : "Baseline Edge/EV: N/A",
          cm
            ? `Challenger ${esc(cm.side)} Edge ${cm.edge.toFixed(1)} pp / EV ${cm.ev.toFixed(1)}%`
            : "Challenger Edge/EV: N/A",
          `baselineCategory: <b>${esc(shadow.baseline.category)}</b>`,
          `challengerShadowCategory: <b>${esc(shadow.challenger.shadowCategory)}</b>`
        ];
      }
    }

    return tg("sendMessage", {
      chat_id: chatId,
      text: [`<b>${title}</b>`, "", `<b>${esc(item.home)} - ${esc(item.away)}</b>`, "", ...lines].join("\n"),
      parse_mode: "HTML",
      reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
    });
  }

  async function showCard(chatId, id) {
    const state = stateRef.current;
    const item = state.fixtures.find(x => x.id === id);
    if (!item) return;
    const dq = item.diagnostics?.dataQualityV2;
    const risk = item.diagnostics?.risk;
    const cleanLines = [
      `<b>${esc(item.home)} - ${esc(item.away)}</b>`,
      esc(item.competition),
      `Kickoff: ${formatKyivDate(item.utcDate)}`,
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
      text: cleanLines.join("\n"),
      parse_mode: "HTML",
      reply_markup: keyboard([
        [
          { text: "DQ", callback_data: `dq:${item.id}` },
          { text: "Risk", callback_data: `risk:${item.id}` }
        ],
        [
          { text: "Sources", callback_data: `sources:${item.id}` },
          { text: "Sanity", callback_data: `sanity:${item.id}` }
        ],
        [{ text: "Shadow", callback_data: `shadow:${item.id}` }],
        [{ text: "Dashboard", callback_data: "dashboard" }]
      ])
    });

    const lines = [
      `<b>${esc(item.home)} - ${esc(item.away)}</b>`,
      esc(item.competition),
      `Начало: ${formatKyivDate(item.utcDate)}`,
      "",
      `Статус: <b>${item.category.toUpperCase()}</b>`,
      "OFFICIAL = <b>BASELINE</b>",
      `Baseline DQ: <b>${item.dataQuality}/100</b>`,
      dq ? `DQ v2: <b>${dq.scoreNormalized}/100</b>` : "DQ v2: нет данных",
      risk ? `Risk: <b>${risk.score}/100</b>` : "Risk: нет данных",
      risk ? `Model Agreement: <b>${risk.modelAgreement}/100</b>` : "Model Agreement: нет данных",
      item.diagnostics?.decisionConfidenceV2 !== undefined
        ? `Decision Confidence v2: <b>${item.diagnostics.decisionConfidenceV2}/100</b>`
        : "Decision Confidence v2: нет данных"
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
      reply_markup: keyboard([
        [
          { text: "DQ", callback_data: `dq:${item.id}` },
          { text: "Risk", callback_data: `risk:${item.id}` }
        ],
        [
          { text: "Sources", callback_data: `sources:${item.id}` },
          { text: "Sanity", callback_data: `sanity:${item.id}` }
        ],
        [{ text: "🧪 Shadow", callback_data: `shadow:${item.id}` }],
        [{ text: "Dashboard", callback_data: "dashboard" }]
      ])
    });
  }

  function formatPercent(value) {
    return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
  }

  async function showAuditScreen(chatId, kind) {
    const audit = typeof auditStats === "function" ? auditStats() : null;
    const daily = typeof dailyAudit === "function" ? dailyAudit() : null;
    const shadow = typeof shadowStats === "function" ? shadowStats() : null;
    let title = "Statistics";
    let lines = [];

    if (kind === "stats") {
      title = "Statistics";
      lines = audit ? [
        `Official bets: <b>${audit.overall.officialBets}</b>`,
        `Settled: <b>${audit.overall.settledBets}</b>`,
        `W-L-P: <b>${audit.overall.win}-${audit.overall.loss}-${audit.overall.push}</b>`,
        `Units: <b>${audit.overall.netUnits.toFixed(2)}</b>`,
        `ROI: <b>${formatPercent(audit.overall.roi)}</b>`
      ] : ["No audit data."];
    }

    if (kind === "daily") {
      title = "Daily Audit";
      lines = daily ? [
        `Date Kyiv: <b>${esc(daily.dateKyiv)}</b>`,
        `Issued: <b>${daily.officialValueIssued}</b>`,
        `Settled: <b>${daily.settled}</b>`,
        `Pending: <b>${daily.pending}</b>`,
        `Units: <b>${daily.betting.netUnits.toFixed(2)}</b>`,
        `ROI: <b>${formatPercent(daily.betting.roi)}</b>`
      ] : ["No daily audit data."];
    }

    if (kind === "clv") {
      title = "CLV";
      lines = [
        "CLV foundation is active.",
        "Headline CLV waits for valid pre-kickoff closing odds.",
        "LOW-quality CLV is not mixed into headline metrics."
      ];
    }

    if (kind === "shadow_stats") {
      title = "Shadow Stats";
      lines = shadow ? [
        `Sample: <b>${shadow.sampleSize}/300</b>`,
        `Baseline Brier: <b>${shadow.baseline.brier?.toFixed?.(4) ?? "N/A"}</b>`,
        `Challenger Brier: <b>${shadow.challenger.brier?.toFixed?.(4) ?? "N/A"}</b>`,
        `Baseline LogLoss: <b>${shadow.baseline.logLoss?.toFixed?.(4) ?? "N/A"}</b>`,
        `Challenger LogLoss: <b>${shadow.challenger.logLoss?.toFixed?.(4) ?? "N/A"}</b>`,
        `Strong disagreement: <b>${shadow.strongDisagreementCount}</b>`
      ] : ["No shadow stats."];
    }

    if (kind === "sources") {
      title = "Sources";
      const telemetry = stateRef.current.telemetry;
      const coverage = telemetry?.coverage || {};
      lines = [
        ...healthLines(stateRef.current.sourceHealth),
        "",
        coverage.market ? `Market: <b>${coverage.market.numerator}/${coverage.market.denominator}</b> (${coverage.market.percent}%)` : "Market: N/A",
        coverage.apiFootball ? `API-Football: <b>${coverage.apiFootball.numerator}/${coverage.apiFootball.denominator}</b> (${coverage.apiFootball.percent}%)` : "API-Football: N/A",
        coverage.injuries ? `Injuries: <b>${coverage.injuries.numerator}/${coverage.injuries.denominator}</b> (${coverage.injuries.percent}%)` : "Injuries: N/A",
        coverage.lineups ? `Lineups: <b>${coverage.lineups.numerator}/${coverage.lineups.denominator}</b> (${coverage.lineups.percent}%)` : "Lineups: N/A",
        coverage.xg ? `xG: <b>${coverage.xg.numerator}/${coverage.xg.denominator}</b> (${esc(coverage.xg.status)})` : "xG: N/A"
      ];
    }

    if (kind === "blockers") {
      title = "Why no VALUE?";
      const blockers = stateRef.current.telemetry?.blockers?.top || [];
      lines = blockers.length
        ? blockers.map(row => `${esc(row.reason)}: <b>${row.count}</b>`)
        : ["No blockers recorded."];
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
      await tg("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Доступ закрыт.",
        show_alert: false
      }).catch(() => {});
      return;
    }

    await tg("answerCallbackQuery", { callback_query_id: query.id });

    if (query.data === "dashboard") return sendDashboard(chatId, query.message.message_id);
    if (query.data === "stats") return showAuditScreen(chatId, "stats");
    if (query.data === "sources_overview") return showAuditScreen(chatId, "sources");
    if (query.data === "blockers") return showAuditScreen(chatId, "blockers");
    if (query.data === "daily_audit") return showAuditScreen(chatId, "daily");
    if (query.data === "clv") return showAuditScreen(chatId, "clv");
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
