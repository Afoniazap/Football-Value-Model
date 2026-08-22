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

const DQ_COMPONENTS = Object.freeze({
  historicalSample: { label: "История матчей", source: "Football-Data" },
  freshness: { label: "Свежесть истории", source: "Football-Data" },
  homeAwaySplits: { label: "Дом/выезд", source: "Football-Data" },
  recentFormCoverage: { label: "Текущая форма", source: "Football-Data" },
  marketCoverage: { label: "Рыночные котировки", source: "odds-api.io / букмекер или другой активный market provider" },
  xgCoverage: { label: "xG", source: "xG-провайдер не подключён" },
  squadCoverage: { label: "Составы и травмы", source: "API-Football" }
});

const FLAG_TEXT = Object.freeze({
  LINEUPS_NOT_CONFIRMED: "Подтверждённые составы пока недоступны; баллы не снимаются.",
  INJURIES_REPORTED: "Есть явно опубликованные травмы/отсутствия; без оценки важности игрока баллы не снимаются.",
  SOURCE_PARTIAL: "Источник вернул неполные данные.",
  MODEL_DISAGREEMENT: "Компоненты внутренней модели расходятся.",
  MARKET_DISAGREEMENT: "Котировки букмекеров заметно расходятся."
});

function gap(value, threshold, unit = "") {
  if (!Number.isFinite(Number(value))) return "Проверка невозможна: значение N/A.";
  const missing = Number(threshold) - Number(value);
  return missing > 0
    ? `Не хватает <b>${fixed(missing, unit === "%" ? 1 : 0)}${unit}</b> до порога ${threshold}${unit}.`
    : `Порог ${threshold}${unit} пройден с запасом <b>${fixed(-missing, unit === "%" ? 1 : 0)}${unit}</b>.`;
}

function dqDiagnostic(item, thresholds) {
  const dq = item.diagnostics?.dataQualityV2;
  const productionDq = item.dataQuality;
  const threshold = thresholds.minDataQuality;
  if (!dq) return { title: "📚 DQ", lines: ["Компонентная оценка DQ: <b>N/A</b>.", "Отсутствие расчёта не считается автоматически плохим качеством."] };
  const componentLines = dq.components.map(part => {
    const meta = DQ_COMPONENTS[part.name] || { label: part.name, source: "внутренний расчёт FVM" };
    if (part.status === "N/A") return `➖ ${meta.label}: <b>N/A</b> — ${escHtml(part.note || "источник недоступен")}`;
    const icon = part.score === part.max ? "✅" : part.score > 0 ? "🟡" : "🔴";
    return `${icon} ${meta.label}: <b>${part.score}/${part.max}</b>${part.note ? ` — ${escHtml(part.note)}` : ""}`;
  });
  const sources = [...new Set(dq.components.map(part => DQ_COMPONENTS[part.name]?.source).filter(Boolean))];
  return { title: "📚 DQ", lines: [
    "Показывает полноту и свежесть фактических данных до начала матча.",
    `Компонентный DQ v2: <b>${dq.scoreNormalized}/100</b> (${dq.rawScore}/${dq.availableMax} доступных баллов).`,
    `Production DQ: <b>${productionDq ?? "N/A"}/100</b> · порог <b>${threshold}/100</b>.`,
    "",
    "<b>Состав</b>", ...componentLines,
    "", "<b>Источники</b>", ...sources.map(source => `• ${escHtml(source)}`),
    "", `<b>Почему такой итог</b>: ${dq.rawScore} набрано из ${dq.availableMax} доступных баллов; только xG со статусом N/A исключён из доступного максимума текущей формулой.`,
    "Context не входит в DQ и остаётся SHADOW ONLY.",
    gap(productionDq, threshold)
  ] };
}

function confidenceDiagnostic(item) {
  const c = item.candidate;
  const value = item.confidence;
  if (!c || !Number.isFinite(value)) return { title: "🎛 Confidence", lines: [
    "Показывает уверенность production-решения при наличии рыночной котировки.",
    "Текущее значение: <b>N/A</b> · порог VALUE <b>70/100</b>.",
    "Котировка или кандидат отсутствуют, поэтому показатель не рассчитывается. N/A не означает плохое качество."
  ] };
  const dqPart = item.dataQuality * 0.55;
  const edgePart = Math.max(0, c.edge) * 2.4;
  return { title: "🎛 Confidence", lines: [
    "Показывает уверенность production-решения с учётом данных базовой модели и преимущества над рынком.",
    `Текущее значение: <b>${value}/100</b> · порог VALUE <b>70/100</b>.`,
    "", "<b>Состав</b>",
    `• Production DQ: ${item.dataQuality} × 0,55 = <b>${fixed(dqPart, 1)}</b> — Football-Data и внутренний расчёт FVM`,
    `• Положительный Edge: max(0; ${fixed(c.edge, 1)}) × 2,4 = <b>${fixed(edgePart, 1)}</b> — модель FVM и букмекерский рынок`,
    "• Базовая добавка: <b>18,0</b> — внутренний расчёт FVM",
    `• Ограничение сверху: <b>88</b>`,
    "• Context не входит в Confidence и остаётся SHADOW ONLY",
    "", `<b>Расчёт</b>: round(min(88; ${fixed(dqPart, 1)} + ${fixed(edgePart, 1)} + 18)) = <b>${value}</b>.`,
    gap(value, 70)
  ] };
}

function riskDiagnostic(item) {
  const risk = item.diagnostics?.risk;
  if (!risk) return { title: "🛡 Risk", lines: ["Оценка риска: <b>N/A</b>.", "N/A означает отсутствие расчёта, а не высокий риск."] };
  const deductions = (risk.redFlags || []).filter(flag => ["SOURCE_PARTIAL", "MODEL_DISAGREEMENT", "MARKET_DISAGREEMENT"].includes(flag.code));
  const sourcePenalty = deductions.filter(flag => flag.code === "SOURCE_PARTIAL").reduce((sum, flag) => sum + (flag.severity === "MEDIUM" ? 12 : 6), 0);
  const modelPenalty = deductions.some(flag => flag.code === "MODEL_DISAGREEMENT") ? 12 : 0;
  const marketPenalty = deductions.some(flag => flag.code === "MARKET_DISAGREEMENT") ? 6 : 0;
  return { title: "🛡 Risk", lines: [
    "Шкала обратная привычному слову «риск»: <b>100 — лучше и устойчивее, 0 — хуже</b>.",
    `Текущее значение: <b>${risk.score}/100</b> · диагностический проходной уровень <b>70/100</b>.`,
    "", "<b>Состав</b>",
    "• Начальная устойчивость: <b>100</b>",
    `• Неполные/ошибочные источники: <b>−${sourcePenalty}</b> — статусы Football-Data, API-Football и market providers`,
    `• Расхождение компонентов модели: <b>−${modelPenalty}</b> — внутренний расчёт FVM; согласие ${risk.modelAgreement}/100`,
    `• Расхождение букмекеров: <b>−${marketPenalty}</b> — реальные котировки рынка`,
    "", ...(risk.redFlags?.length ? risk.redFlags.map(flag => `• ${escHtml(FLAG_TEXT[flag.code] || flag.message || flag.code)} [${escHtml(flag.source || "FVM")}]`) : ["✅ Флаги риска отсутствуют."]),
    "", `<b>Расчёт</b>: 100 − ${sourcePenalty} − ${modelPenalty} − ${marketPenalty} = <b>${risk.score}</b>.`,
    gap(risk.score, 70)
  ] };
}

function marketMetricDiagnostic(item, kind, thresholds) {
  const c = item.candidate;
  const source = item.diagnostics?.market?.source || "market provider";
  if (!c) {
    const marketPresent = source && !["NONE", "N/A", "market provider"].includes(source);
    const why = !item.model
      ? "Базовая модель не рассчитана из-за недостатка данных."
      : item.dataQuality < thresholds.minDataQuality
        ? `Production DQ ${item.dataQuality}/100 ниже порога ${thresholds.minDataQuality}/100, поэтому кандидат не строится.`
        : marketPresent
          ? "Рынок найден, но production-кандидат для решения не сформирован."
          : "Реальная рыночная котировка отсутствует.";
    return { title: `📐 ${kind.toUpperCase()}`, lines: ["Значение: <b>N/A</b>.", `${why} Поэтому расчёт невозможен. N/A не является нулём и не считается плохим результатом.`] };
  }
  const marketProbability = item.marketProbability?.[c.key];
  if (kind === "edge") return { title: "📏 Edge", lines: [
    "Показывает разницу между вероятностью FVM и очищенной от маржи вероятностью рынка.",
    `Текущее значение: <b>${fixed(c.edge, 1)}%</b> · порог VALUE <b>${thresholds.minEdgePercent}%</b>.`,
    `• Вероятность FVM: <b>${fixed(c.probability * 100, 1)}%</b> — Football-Data и внутренняя модель FVM`,
    `• Вероятность рынка без маржи: <b>${marketProbability === undefined ? "N/A" : `${fixed(marketProbability * 100, 1)}%`}</b> — ${escHtml(source)} / ${escHtml(item.bookmaker || "букмекер")}`,
    `Расчёт: ${fixed(c.probability * 100, 1)}% − ${fixed((marketProbability ?? 0) * 100, 1)}% = <b>${fixed(c.edge, 1)}%</b>.`,
    gap(c.edge, thresholds.minEdgePercent, "%")
  ] };
  if (kind === "ev") return { title: "💹 EV", lines: [
    "Показывает ожидаемую доходность ставки на дистанции при вероятности FVM и текущем коэффициенте.",
    `Текущее значение: <b>${fixed(c.ev, 1)}%</b> · порог VALUE <b>4%</b>.`,
    `• Вероятность FVM: <b>${fixed(c.probability * 100, 1)}%</b> — Football-Data и внутренняя модель FVM`,
    `• Коэффициент: <b>${fixed(c.odds)}</b> — ${escHtml(source)} / ${escHtml(item.bookmaker || "букмекер")}`,
    `Расчёт: (${fixed(c.probability, 4)} × ${fixed(c.odds)} − 1) × 100 = <b>${fixed(c.ev, 1)}%</b>.`,
    gap(c.ev, 4, "%")
  ] };
  return { title: "⚖️ Fair Odds", lines: [
    "Справедливый коэффициент FVM без букмекерской маржи; отдельного проходного порога у него нет.",
    `Текущее значение: <b>${fixed(c.fairOdds)}</b>.`,
    `• Вероятность FVM: <b>${fixed(c.probability * 100, 1)}%</b> — Football-Data и внутренняя модель FVM`,
    `Расчёт: 1 ÷ ${fixed(c.probability, 4)} = <b>${fixed(c.fairOdds)}</b>.`,
    `Для сравнения: реальный коэффициент букмекера <b>${fixed(c.odds)}</b> — ${escHtml(source)} / ${escHtml(item.bookmaker || "букмекер")}.`
  ] };
}

function stabilityDiagnostic(item) {
  const stability = item.diagnostics?.stability || item.stability;
  if (!stability) return { title: "🧱 Stability", lines: [
    "Показывал бы устойчивость решения к обновлениям данных и котировок.",
    "Текущее значение: <b>N/A</b> · production-порог не определён.",
    "В текущем pipeline отдельный расчёт Stability отсутствует. Поэтому компоненты и баллы не выдумываются, а N/A не считается плохим качеством данных."
  ] };
  return { title: "🧱 Stability", lines: [`Текущее значение: <b>${escHtml(stability.status || stability.score)}</b>.`, "Источник: внутренняя история обновлений FVM."] };
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

export function renderFixtureDiagnostic(item, kind, thresholds = { minDataQuality: 65, minEdgePercent: 4 }) {
  const d = item.diagnostics || {};
  if (kind === "dq") return dqDiagnostic(item, thresholds);
  if (kind === "confidence") return confidenceDiagnostic(item);
  if (kind === "risk") return riskDiagnostic(item);
  if (["edge", "ev", "fair"].includes(kind)) return marketMetricDiagnostic(item, kind, thresholds);
  if (kind === "stability") return stabilityDiagnostic(item);
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
