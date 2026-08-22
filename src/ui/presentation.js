import { UI_LABELS } from "./labels.js";
import { formatKyivDateLabel } from "./time.js";

const STATUS = Object.freeze({ OK: "✅", PARTIAL: "⚠️", ERROR: "❌", BLOCKED: "⛔", N_A: "➖" });

export function escHtml(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function pct(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "Недостаточно данных"
    : `${(Number(value) * 100).toFixed(1)}%`;
}

function fixed(value, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "N/A" : Number(value).toFixed(digits);
}

function healthText(health) {
  if (!health) return `${STATUS.N_A} N/A — источник не отчитался`;
  const icon = STATUS[health.status] || (health.status === "N/A" ? STATUS.N_A : "ℹ️");
  const reason = health.meta?.reason || health.error?.code;
  return `${icon} ${health.status}${reason ? ` — ${reason}` : ""}`;
}

function sampleRow(label, row) {
  if (!row || row.officialBets === 0) return `${escHtml(label)}: <b>Недостаточно данных (n=0)</b>`;
  return `${escHtml(label)}: n=<b>${row.officialBets}</b>, рассчитано <b>${row.settledBets}</b>, результат <b>${fixed(row.netUnits)} ед.</b>, ROI <b>${pct(row.roi)}</b>`;
}

function probabilityLine(label, values) {
  if (!values) return `${label}: <b>N/A</b>`;
  return `${label}: П1 <b>${pct(values.home)}</b> · X <b>${pct(values.draw)}</b> · П2 <b>${pct(values.away)}</b>`;
}

function reasonText(reason) {
  const map = {
    NO_MARKET: "нет подтверждённых рыночных котировок",
    MARKET_UNAVAILABLE: "рынок недоступен у провайдеров",
    MARKET_UNSUPPORTED_COMPETITION: "соревнование не поддерживается рыночными провайдерами",
    LOW_DATA_QUALITY: "недостаточное качество исходных данных",
    LOW_DQ: "недостаточное качество исходных данных",
    LOW_CONFIDENCE: "недостаточная уверенность модели",
    LOW_EDGE: "преимущество над рынком ниже рабочего порога",
    LOW_EV: "ожидаемая доходность ниже рабочего порога",
    HIGH_RISK: "риск выше допустимого уровня",
    MARKET_NO_QUOTES: "провайдер не вернул котировки",
    MARKET_PROVIDER_QUOTA: "исчерпана квота основного провайдера",
    MARKET_EVENT_NOT_MATCHED: "рыночное событие не сопоставлено с матчем",
    MARKET_STALE: "котировка устарела",
    SOURCE_PARTIAL: "источник вернул неполные данные",
    SANITY_REVIEW: "требуется ручная проверка согласованности",
    NO_VALUE: "условия VALUE не выполнены"
  };
  return map[reason] || reason || "причина не зафиксирована";
}

export function renderDashboard({ state, audit, shadow }) {
  const t = state.telemetry;
  const updated = t?.finishedAt || state.updatedAt;
  const system = state.loading ? "ОБНОВЛЕНИЕ" : state.systemReadiness?.status || "DEGRADED";
  const fixtures = t?.fixturesInsideExactHorizon ?? state.fixtures?.length ?? 0;
  const market = t?.coverage?.market;
  const dq = t?.dqDistribution;
  return [
    "<b>⚽ FVM — обзор</b>",
    `${system === "READY" ? "✅" : "⚠️"} Система: <b>${escHtml(system)}</b>`,
    `🕒 Обновлено: <b>${updated ? formatKyivDateLabel(updated) : "ещё нет"}</b>`,
    "",
    `<b>Ближайшие ${fixtures} матчей (${escHtml(String(t?.horizonHours || 24))} ч.)</b>`,
    `Рынки: <b>${market ? `${market.numerator}/${market.denominator} (${market.percent}%)` : "N/A"}</b>`,
    `Качество данных: <b>${dq?.average ?? "N/A"}/100</b>${dq ? ` · высокое ${dq.high}, среднее ${dq.mid}, низкое ${dq.low}` : ""}`,
    "",
    `${UI_LABELS.value}: <b>${t?.categories?.VALUE ?? state.value?.length ?? 0}</b>`,
    `${UI_LABELS.near}: <b>${t?.categories?.NEAR ?? state.near?.length ?? 0}</b>`,
    `${UI_LABELS.wait}: <b>${t?.categories?.WAIT ?? state.wait?.length ?? 0}</b>`,
    `${UI_LABELS.noBet}: <b>${t?.categories?.NO_BET ?? state.rejected?.length ?? 0}</b>`,
    "",
    `Официальные сигналы: <b>${audit?.overall?.officialBets ?? 0}</b> · рассчитано <b>${audit?.overall?.settledBets ?? 0}</b>`,
    `ROI: <b>${pct(audit?.overall?.roi)}</b>`,
    `Shadow-выборка: <b>${shadow?.sampleSize ?? 0}</b>${(shadow?.sampleSize ?? 0) === 0 ? " — недостаточно данных" : ""}`
  ].join("\n");
}

export function renderMatchCard(item) {
  const d = item.diagnostics || {};
  const dq = d.dataQualityV2;
  const risk = d.risk;
  const c = item.candidate;
  return [
    `<b>⚽ ${escHtml(item.home)} — ${escHtml(item.away)}</b>`,
    `${escHtml(item.competition)} · ${formatKyivDateLabel(item.utcDate)}`,
    "",
    "<b>Вероятности</b>",
    probabilityLine("Основная модель", item.model),
    probabilityLine("Теневая модель", item.shadow?.challenger?.probabilities),
    "",
    "<b>Рынок и оценка</b>",
    `Источник: <b>${escHtml(d.market?.source || "N/A")}</b> · букмекер: <b>${escHtml(item.bookmaker || "N/A")}</b>`,
    c ? `Выбор: <b>${escHtml(c.side)}</b> @ <b>${fixed(c.odds)}</b> · справедливый кэф. <b>${fixed(c.fairOdds)}</b>` : `Котировки: <b>N/A</b> — ${escHtml(reasonText(d.market?.reason))}`,
    c ? `Edge: <b>${fixed(c.edge, 1)}%</b> · EV: <b>${fixed(c.ev ?? c.expectedValue, 1)}%</b>` : "Edge и EV: <b>N/A</b> — без котировки не рассчитываются",
    "",
    "<b>Надёжность решения</b>",
    `DQ: <b>${dq ? `${dq.scoreNormalized}/100` : "N/A"}</b> — полнота и свежесть входных данных`,
    `Risk: <b>${risk ? `${risk.score}/100` : "N/A"}</b> — устойчивость решения к известным рискам`,
    `Confidence: <b>${item.confidence ?? d.confidence ?? "N/A"}${item.confidence !== undefined || d.confidence !== undefined ? "/100" : ""}</b>`,
    `Stability: <b>${escHtml(d.stability?.status || item.stability?.status || "N/A")}</b>`,
    "",
    `<b>Решение: ${escHtml(String(item.category || "WAIT").toUpperCase())}</b>`,
    `Почему: ${escHtml(reasonText(item.reason || d.market?.reason))}`,
    "Контекст: <b>SHADOW ONLY</b> — не влияет на это решение"
  ].join("\n");
}

export function renderFixtureDiagnostic(item, kind) {
  const d = item.diagnostics || {};
  if (kind === "dq") {
    const dq = d.dataQualityV2;
    return { title: "🔎 Качество данных", lines: dq ? [
      `Итог: <b>${dq.scoreNormalized}/100</b> (${dq.rawScore}/${dq.availableMax} доступных баллов)`,
      "",
      ...dq.components.map(p => `${p.score === p.max ? "✅" : p.score ? "⚠️" : "❌"} ${escHtml(p.name)}: <b>${p.score}/${p.max}</b>${p.note ? ` — ${escHtml(p.note)}` : ""}`)
    ] : ["Данные DQ недоступны."] };
  }
  if (kind === "risk") {
    const risk = d.risk;
    return { title: "⚠️ Риски", lines: risk ? [
      `Оценка: <b>${risk.score}/100</b> · согласие моделей: <b>${risk.modelAgreement}/100</b>`,
      "",
      ...(risk.redFlags?.length ? risk.redFlags.map(f => `• ${escHtml(f.message || f.code)} (${escHtml(f.severity)})`) : ["✅ Существенные флаги риска не обнаружены."])
    ] : ["Оценка риска недоступна."] };
  }
  if (kind === "sources") return { title: "🌐 Источники матча", lines: Object.entries(d.providerHealth || {}).map(([name, h]) => `${escHtml(name)}: <b>${escHtml(healthText(h))}</b>`) };
  if (kind === "sanity") return { title: "🧭 Проверки здравого смысла", lines: d.sanityWarnings?.length ? d.sanityWarnings.map(w => `• ${escHtml(w.message || w.reason)}`) : ["✅ Предупреждений нет."] };
  if (kind === "shadow") {
    const s = item.shadow;
    return { title: "🧪 Shadow", lines: ["Официальное решение всегда формирует основная модель.", `Статус: <b>${escHtml(s?.shadowStatus || "N/A")}</b>`, `Согласие: <b>${escHtml(s?.disagreementStatus || "N/A")}</b>`, "Теневая модель не влияет на production-решение."] };
  }
  const c = item.contextAnalysis;
  return { title: "🧠 Контекст", lines: c ? [
    "Режим: <b>SHADOW ONLY</b>",
    `Хозяева: <b>${c.scoreHome > 0 ? "+" : ""}${c.scoreHome}</b> · гости: <b>${c.scoreAway > 0 ? "+" : ""}${c.scoreAway}</b>`,
    `Уверенность: <b>${c.confidence}/100</b> · независимых источников: <b>${c.independentSources}</b>`,
    `Противоречий: <b>${c.contradictions}</b>`,
    "",
    ...(c.events?.length ? c.events.slice(0, 8).map(e => `• ${escHtml(e.title || e.category)} · ${escHtml(e.source?.name || e.sourceName || "источник")}`) : ["Релевантных событий до начала матча нет."]),
    "",
    "Контекст не изменяет вероятность, VALUE, DQ, Confidence или FDS."
  ] : ["Контекстные данные для матча отсутствуют.", "Режим остаётся SHADOW ONLY."] };
}

export function renderAudit(kind, { audit, daily, shadow, state }) {
  if (kind === "stats") {
    if (!audit) return { title: UI_LABELS.statistics, lines: ["История аудита недоступна."] };
    const o = audit.overall;
    return { title: UI_LABELS.statistics, lines: [
      "Данные только из append-only истории официальных сигналов и расчётов.",
      `Сигналов: <b>${o.officialBets}</b> · рассчитано: <b>${o.settledBets}</b> · ожидают: <b>${audit.integrity?.pending ?? "N/A"}</b>`,
      `W-L-P: <b>${o.win}-${o.loss}-${o.push}</b> · результат: <b>${fixed(o.netUnits)} ед.</b> · ROI: <b>${pct(o.roi)}</b>`,
      "",
      "<b>По рынкам</b>", ...(Object.entries(audit.byMarket || {}).length ? Object.entries(audit.byMarket).map(([k,v]) => sampleRow(k,v)) : ["Недостаточно данных (n=0)"]),
      "", "<b>По диапазонам коэффициентов</b>", ...(Object.entries(audit.byOddsBand || {}).length ? Object.entries(audit.byOddsBand).map(([k,v]) => sampleRow(k,v)) : ["Недостаточно данных (n=0)"])
    ] };
  }
  if (kind === "daily") return { title: "📅 Дневной аудит", lines: daily ? [
    `Дата (Киев): <b>${escHtml(daily.dateKyiv)}</b>`, `Выдано: <b>${daily.officialValueIssued}</b> · рассчитано: <b>${daily.settled}</b> · ожидают: <b>${daily.pending}</b>`,
    `Результат: <b>${fixed(daily.betting.netUnits)} ед.</b> · ROI: <b>${pct(daily.betting.roi)}</b>`
  ] : ["Дневная история недоступна."] };
  if (kind === "shadow_stats") return { title: "🧪 Shadow-статистика", lines: shadow && shadow.sampleSize ? [
    `Выборка: <b>${shadow.sampleSize}</b>`, `Brier основной: <b>${fixed(shadow.baseline?.brier, 4)}</b>`, `Brier теневой: <b>${fixed(shadow.challenger?.brier, 4)}</b>`, `Сильных расхождений: <b>${shadow.strongDisagreementCount ?? 0}</b>`, "Shadow не влияет на production."
  ] : ["Недостаточно данных (n=0).", "Проценты и качество модели не рассчитываются до появления реальной выборки.", "Shadow не влияет на production."] };
  if (kind === "blockers") {
    const rows = state.telemetry?.blockers?.top || [];
    const byFixture = state.telemetry?.blockers?.byFixture || {};
    const lines = [];
    for (const row of rows) {
      lines.push(`• ${escHtml(reasonText(row.reason))}: <b>${row.count}</b>`);
      const names = (state.fixtures || []).filter(item => byFixture[item.id]?.includes(row.reason)).slice(0, 5).map(item => `${item.home} — ${item.away}`);
      if (names.length) lines.push(`  ${escHtml(names.join("; "))}${row.count > names.length ? `; ещё ${row.count - names.length}` : ""}`);
    }
    return { title: UI_LABELS.whyNoValue, lines: lines.length ? lines : ["За последний цикл блокирующие причины не зафиксированы."] };
  }
  const coverage = state.telemetry?.coverage || {};
  const health = state.sourceHealth || {};
  return { title: UI_LABELS.sources, lines: [
    "<b>Состояние провайдеров</b>",
    ...Object.entries(health).map(([name, h]) => `${escHtml(name)}: <b>${escHtml(healthText(h))}</b>`),
    "", "<b>Фактическое покрытие</b>",
    `Рынки: <b>${coverage.market ? `${coverage.market.numerator}/${coverage.market.denominator} (${coverage.market.percent}%)` : "N/A"}</b>`,
    `API-Football: <b>${coverage.apiFootball ? `${coverage.apiFootball.numerator}/${coverage.apiFootball.denominator}` : "N/A"}</b>`,
    `Составы: <b>${coverage.lineups ? `${coverage.lineups.numerator}/${coverage.lineups.denominator}` : "N/A"}</b>`,
    `xG: <b>${coverage.xg ? `${coverage.xg.numerator}/${coverage.xg.denominator} — ${escHtml(coverage.xg.status)}` : "N/A"}</b>`
  ] };
}
