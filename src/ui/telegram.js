import { localDate } from "../engine/utils.js";

function esc(s="") { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function kb(rows) { return {inline_keyboard:rows}; }

export function dashboardText(state) {
  const total = state.results.length;
  const counts = Object.fromEntries(["VALUE","NEAR","WAIT","NO_BET"].map(k=>[k,state.results.filter(x=>x.category===k).length]));
  const processedMarkets = state.results.filter(x=>x.marketAvailable).length;
  const calculatedMarkets = state.results.filter(x=>Array.isArray(x.markets)&&x.markets.length>0).length;
  const health = total ? Math.round(state.results.reduce((s,x)=>s+x.dataQuality,0)/total) : 0;
  const opportunity = total ? Math.round(Math.min(100,(counts.VALUE*20+counts.NEAR*8)/total*100)) : 0;
  const api = state.providers?.apiFootball;
  const fixtureProvider = state.providers?.fixtures;
  const market = state.providers?.market;
  const fixtureCount = api?.dailyLimit && !state.updatedAt ? "N/A" : total;
  return [
    "⚽ <b>FOOTBALL VALUE MODEL v1.0</b>",
    "",
    state.loading ? "🟡 Анализ выполняется" : "🟢 Анализ завершён",
    `Pipeline: <b>${state.loading ? state.stage : "9/9 Complete"}</b>`,
    "",
    `Health Score: <b>${health}/100</b>`,
    `Opportunity Index: <b>${opportunity}/100</b>`,
    "",
    `Матчей на 24 часа: <b>${fixtureCount}</b>`,
    `Котировки найдены: <b>${processedMarkets}/${total}</b>`,
    `Рынков рассчитано: <b>${calculatedMarkets}/${total}</b>`,
    `✅ VALUE: <b>${counts.VALUE}</b>`,
    `🟡 Near Value: <b>${counts.NEAR}</b>`,
    `🟠 WAIT: <b>${counts.WAIT}</b>`,
    `❌ NO BET: <b>${counts.NO_BET}</b>`,
    "",
    `Обновлено: <b>${state.updatedAt ? localDate(state.updatedAt) : "—"}</b>`,
    state.errors.length ? `⚠️ Ошибок источников: <b>${state.errors.length}</b>` : "Источники: ✅",
    api ? `API-Football: <b>${api.dailyLimit ? "DAILY LIMIT" : "OK"}</b> · req ${api.requests} · cache ${api.cacheHits + api.staleHits} · saved ${api.avoided}` : null,
    fixtureProvider ? `Fixtures: <b>${fixtureProvider.status}</b> · ${fixtureProvider.source || fixtureProvider.reason || "UNAVAILABLE"}` : null,
    market ? `Markets: Odds <b>${market.primary?.status || "N/A"}</b> · odds-api.io <b>${market.oddsApiIo?.status || "N/A"}</b> · AF <b>${market.apiFootballOdds?.status || "N/A"}</b>` : null
  ].filter(Boolean).join("\n");
}

export function dashboardKeyboard(state) {
  const count = k => state.results.filter(x=>x.category===k).length;
  return kb([
    [{text:`🎯 VALUE (${count("VALUE")})`,callback_data:"list:VALUE"},
     {text:`👀 Near (${count("NEAR")})`,callback_data:"list:NEAR"}],
    [{text:`⏳ WAIT (${count("WAIT")})`,callback_data:"list:WAIT"},
     {text:`❌ NO BET (${count("NO_BET")})`,callback_data:"list:NO_BET"}],
    [{text:"⚙️ Pipeline",callback_data:"pipeline"},
     {text:"🔄 Обновить",callback_data:"refresh"}],
    [{text:"📈 Статистика",callback_data:"statistics"}]
  ]);
}

export function statisticsText(statistics={}){
  const pct=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:"N/A";
  const num=value=>Number.isFinite(value)?Number(value).toFixed(3):"N/A";
  const categories=statistics.categoryCounts||{};
  return [
    "<b>📈 Накопительная статистика FVM</b>","",
    `Прогнозов сохранено: <b>${statistics.predictions||0}</b>`,
    `Матчей завершено: <b>${statistics.completed||0}</b>`,
    `Ожидают результата: <b>${statistics.pending||0}</b>`,
    `Прогресс выборки: <b>${statistics.completed||0}/${statistics.promotionTarget||300}</b>`,"",
    `Accuracy: <b>${pct(statistics.accuracy)}</b>`,
    `Brier: <b>${num(statistics.brier)}</b>`,
    `Log Loss: <b>${num(statistics.logLoss)}</b>`,
    `Ничьи в факте: <b>${statistics.draws||0}</b>`,"",
    `Средняя P(X): <b>${pct(statistics.meanDrawProbability)}</b>`,
    `Фактические ничьи: <b>${pct(statistics.actualDrawRate)}</b>`,
    `Средняя max P: <b>${pct(statistics.meanMaxProbability)}</b>`,"",
    "<b>Снимки по статусу</b>",
    `VALUE ${categories.VALUE||0} · NEAR ${categories.NEAR||0} · WAIT ${categories.WAIT||0} · NO BET ${categories.NO_BET||0}`,
    ...((statistics.categories||[]).filter(row=>row.predictions).map(row=>`${row.name}: ${row.completed}/${row.predictions} · Acc ${pct(row.accuracy)}`)),
    "","<b>По лигам</b>",
    ...((statistics.leagues||[]).slice(0,8).map(row=>`${esc(row.name)}: ${row.completed}/${row.predictions} · Acc ${pct(row.accuracy)}`)),
    "","<b>По вероятности</b>",
    ...((statistics.bands||[]).map(row=>`${esc(row.name)}: ${row.completed}/${row.predictions} · Acc ${pct(row.accuracy)}`)),
    "","Статистика считается только по реальным завершённым матчам."
  ].join("\n");
}

export function listText(category, items) {
  const title = {VALUE:"🎯 VALUE",NEAR:"👀 NEAR VALUE",WAIT:"⏳ WAIT",NO_BET:"❌ NO BET"}[category];
  if (!items.length) return `<b>${title}</b>\n\nСписок пуст.`;
  return `<b>${title}</b>\n\n` + items.slice(0,20).map((x,i)=>{
    const b=x.best;
    const line=b ? `${b.label} @${b.odds} | Edge ${b.edge.toFixed(1)} | FDS ${b.fds}` : x.reason;
    return `${i+1}. <b>${esc(x.home)} — ${esc(x.away)}</b>\n${esc(x.competition)} · ${localDate(x.utcDate)}\n${esc(line)}`;
  }).join("\n\n");
}

export function listKeyboard(items) {
  const rows=items.slice(0,20).map(x=>{
    const odds = Number.isFinite(Number(x.best?.odds)) ? `@${x.best.odds}` : "@—";
    return [{
      text:`${x.home.slice(0,12)} — ${x.away.slice(0,12)} · ${odds} · ${localDate(x.utcDate)}`,
      callback_data:`card:${x.id}`
    }];
  });
  rows.push([{text:"⬅️ Dashboard",callback_data:"dashboard"}]);
  return kb(rows);
}


function gateLine(name, value, threshold, unit = "") {
  const diff = value - threshold;
  const shortName =
    name === "Confidence" ? "Conf" :
    name === "Data Quality" ? "DQ" :
    name === "Stability" ? "Stab" : name;

  if (diff >= 0)
    return `🟢 ${shortName}: ${value}${unit}/${threshold}${unit} → OK`;

  return `🔴 ${shortName}: ${value}${unit}/${threshold}${unit} → −${Math.abs(diff).toFixed(1)}${unit}`;
}

export function cardText(x) {
  const b = x.best;
  const p = x.consensusProbability;

  const lines = [
    `<b>${x.country ? esc(x.country) + " · " : ""}${esc(x.competition)}</b> · ${localDate(x.utcDate)}`,
    `<b>${esc(x.home)} — ${esc(x.away)}</b>`
  ];

  if (b) {
    lines.push(
      "",
      `🎯 <b>${esc(b.market)} — ${esc(b.label)} @${b.odds}</b>${b.bookmaker ? " · " + esc(b.bookmaker) : ""}`,
      `Model <b>${(b.probability*100).toFixed(1)}%</b> │ Fair <b>${b.fairOdds.toFixed(2)}</b>`,
      `Edge <b>+${b.edge.toFixed(1)} п.п.</b> │ EV <b>+${b.ev.toFixed(1)}%</b>`,
      "",
      `<b>${x.category}</b> · FDS <b>${b.fds}/100</b>`
    );
  } else {
    lines.push("", `<b>${x.category}</b>`, esc(x.reason || "Рынок недоступен."));
  }

  lines.push(
    "",
    `<b>Доступные метрики</b>`,
    `DQ <b>${Number.isFinite(x.dataQuality) ? x.dataQuality+"/100" : "N/A"}</b> · Stability <b>${Number.isFinite(x.stability) ? x.stability+"/100" : "N/A"}</b>`,
    `Consensus <b>${Number.isFinite(x.consensusScore) ? x.consensusScore+"/100" : "N/A"}</b> · Confidence <b>${Number.isFinite(b?.confidence) ? b.confidence+"/100" : x.marketAvailable ? "N/A — нет модельного кандидата" : "N/A — нет цены"}</b>`,
    `Risk flags <b>${Array.isArray(x.redFlags) ? x.redFlags.length : "N/A"}</b>`
  );
  if(x.marketAvailable)lines.push(`Рынок: <b>${esc(x.marketSource || "получен")}</b> · букмекеров ${x.marketDiagnostic?.normalizedBookmakers ?? "N/A"}`);
  if(x.marketDiagnostic?.marketSelection==="BLOCKED_NO_MODEL_CONTEXT")lines.push("Расчёт Fair/Edge/EV заблокирован: недостаточно context для вероятности 1X2.");
  if(x.contextDiagnostic?.status==="UNAVAILABLE")lines.push(`Context: <b>недоступен</b> · ${esc(x.contextDiagnostic.reason || "нет реальных данных")}`);

  if (b) {
    const gates = [
      { name:"Edge", value:b.edge, threshold:4, unit:" п.п." },
      { name:"EV", value:b.ev, threshold:5, unit:"%" },
      { name:"Confidence", value:b.confidence, threshold:70, unit:"" },
      { name:"Data Quality", value:x.dataQuality, threshold:70, unit:"" },
      { name:"Stability", value:x.stability, threshold:70, unit:"" }
    ];

    const failed = gates.filter(g => g.value < g.threshold);

    lines.push(
      "",
      "<b>VALUE Gates</b>",
      ...gates.map(g =>
        gateLine(
          g.name,
          Number(g.value.toFixed ? g.value.toFixed(1) : g.value),
          g.threshold,
          g.unit
        )
      )
    );

    if (failed.length) {
      const worst = failed
        .map(g => ({...g, gap:g.threshold-g.value}))
        .sort((a,b)=>b.gap-a.gap)[0];

      const short =
        worst.name === "Data Quality" ? "DQ" :
        worst.name === "Confidence" ? "Conf" :
        worst.name === "Stability" ? "Stab" :
        worst.name;

      lines.push(
        "",
        `Пройдено <b>${gates.length-failed.length}/${gates.length}</b> · Блокер: 🔴 <b>${short}</b> −${worst.gap.toFixed(1)}${worst.unit}`
      );
    } else {
      lines.push("", `Пройдено <b>5/5</b> · Все gates выполнены ✅`);
    }

    if (b.probability >= 0.90 && x.dataQuality < 70) {
      lines.push(
        "",
        "⚠️ <b>Sanity check:</b> высокая вероятность при низком DQ"
      );
    }
  }

  return lines.join("\n");
}

export function metricKeyboard(x){
  const id = x.id;

  return kb([
    [
      {text:"Edge",callback_data:`metric:Edge:${id}`},
      {text:"EV",callback_data:`metric:EV:${id}`},
      {text:"Conf",callback_data:`metric:Conf:${id}`},
      {text:"DQ",callback_data:`metric:DQ:${id}`},
      {text:"Stab",callback_data:`metric:Stab:${id}`}
    ],
    [
      {text:"📊 Модель",callback_data:`metric:Model:${id}`},
      {text:"⚠️ Риски",callback_data:`metric:Risks:${id}`},
      {text:"📖 Метрики",callback_data:`metric:All:${id}`}
    ],
    [
      {text:"⬅️ Dashboard",callback_data:"dashboard"}
    ]
  ]);
}

export function detailKeyboard(matchId){
  return kb([
    [
      {text:"⬅️ Карточка",callback_data:`card:${matchId}`},
      {text:"🏠 Dashboard",callback_data:"dashboard"}
    ]
  ]);
}

export function metricText(code,x){
  const b = x.best || {};
  const dq = x.dataQualityV2 || {};
  const cp = b.confidenceParts || {};
  const fp = b.fdsParts || {};
  const sv = x.stabilityV2 || {};
  const sci = x.sci || {};
  const blockedMetric=["Fair","Edge","EV","Conf","FDS","MAI"].includes(code)&&!x.best;
  if(blockedMetric){
    const market=x.marketAvailable
      ? `Рыночная цена получена: <b>${esc(x.marketSource || "да")}</b>.`
      : "Рыночная цена отсутствует.";
    const reason=x.marketAvailable&&x.marketDiagnostic?.marketSelection==="BLOCKED_NO_MODEL_CONTEXT"
      ? "Расчёт заблокирован до market selection: недостаточно реального competition/team context для вероятности 1X2. Поэтому Fair Odds, Edge, EV, Confidence, MAI и FDS не вычисляются."
      : "Метрика недоступна, потому что не сформирован рыночный кандидат.";
    return `<b>${esc(code)} — недоступно</b>\n\n${market}\n${reason}`;
  }

  if (code === "Risks") {
    const flags = x.redFlags || [];
    return [
      `<b>⚠️ Риски — ${esc(x.home)} — ${esc(x.away)}</b>`,
      "",
      `Статус: <b>${x.category}</b>`,
      `DQ: <b>${x.dataQuality}/100</b>`,
      `FDS: <b>${b.fds ?? "N/A"}/100</b>`,
      "",
      flags.length
        ? flags.map(r => `🔴 ${esc(r)}`).join("\n")
        : "🟢 Критических Red Flags нет.",
      "",
      b.probability >= 0.90 && x.dataQuality < 70
        ? "⚠️ Высокая модельная вероятность при низком качестве данных."
        : ""
    ].filter(Boolean).join("\n");
  }

  if (code === "All") {
    return [
      `<b>📖 Метрики — ${esc(x.home)} — ${esc(x.away)}</b>`,
      "",
      `DQ: <b>${x.dataQuality}/100</b> — качество данных`,
      `Stability: <b>${x.stability}/100</b> — устойчивость`,
      `Consensus: <b>${x.consensusScore}/100</b> — согласие моделей`,
      `MAI: <b>${x.marketAgreement ?? "N/A"}</b> — согласие рынка`,
      `SCI: <b>${x.sci?.score ?? "N/A"}</b> — календарь/нагрузка`,
      "",
      `Model: <b>${Number.isFinite(b.probability) ? (b.probability*100).toFixed(1)+"%" : "N/A"}</b>`,
      `Fair: <b>${Number.isFinite(b.fairOdds) ? b.fairOdds.toFixed(2) : "N/A"}</b>`,
      `Edge: <b>${Number.isFinite(b.edge) ? b.edge.toFixed(1)+" п.п." : "N/A"}</b>`,
      `EV: <b>${Number.isFinite(b.ev) ? b.ev.toFixed(1)+"%" : "N/A"}</b>`,
      `Confidence: <b>${b.confidence ?? "N/A"}/100</b>`,
      `FDS: <b>${b.fds ?? "N/A"}/100</b>`,
      "",
      "<b>Модели</b>",
      ...(x.models || []).map(m =>
        `• ${esc(m.name)} (${m.quality}/100): ${esc(m.explanation)}`
      )
    ].join("\n");
  }

  const pct = v => Number.isFinite(v) ? (v*100).toFixed(1) : "N/A";
  const n1 = v => Number.isFinite(v) ? Number(v).toFixed(1) : "N/A";

  const texts = {
    DQ:
      `<b>DQ — Data Quality: ${x.dataQuality}/100</b>
Качество данных, на которых построен прогноз.

Выборка матчей: +${dq.sampleScore ?? 0}
Свежесть данных: +${dq.freshnessScore ?? 0}
Дом/выезд: +${dq.homeAwayScore ?? 0}
Форма: +${dq.formScore ?? 0}
Рынок/букмекеры: +${dq.marketScore ?? 0}
xG: +${dq.xgScore ?? 0}
Составы: +${dq.squadScore ?? 0}

<b>Итого: ${x.dataQuality}/100</b>`,

    Stab:
      `<b>Stability: ${x.stability}/100</b>
Устойчивость прогноза.

Consensus: ${sv.consensus ?? x.consensusScore}
Штраф SCI: −${sv.sciPenalty ?? "N/A"}

<b>Итого: ${x.stability}/100</b>`,

    Cons:
      `<b>Consensus: ${x.consensusScore}/100</b>
Насколько независимые модели согласны между собой.

${(x.models || []).map(m =>
  `• ${m.name}: качество ${m.quality}/100
  ${m.explanation}`
).join("\n")}

<b>Согласие: ${x.consensusScore}/100</b>`,

    MAI:
      `<b>MAI: ${x.marketAgreement ?? "N/A"}</b>
Market Agreement Index.

Показывает согласованность доступных букмекерских линий.
Чем выше значение, тем меньше расхождений между источниками рынка.`,

    SCI:
      `<b>SCI: ${sci.score ?? "N/A"}</b>
Нагрузка и отдых команд.

Хозяева: ${sci.home ?? "N/A"}/100
Гости: ${sci.away ?? "N/A"}/100
Отдых хозяев: ${Number.isFinite(sci.restDays?.home) ? sci.restDays.home.toFixed(1)+" дн." : "N/A"}
Отдых гостей: ${Number.isFinite(sci.restDays?.away) ? sci.restDays.away.toFixed(1)+" дн." : "N/A"}

<b>Итог SCI: ${sci.score ?? "N/A"}</b>`,

    Model:
      `<b>Model 1X2</b>
Вероятность выбранного исхода по FVM.

1X2:
П1: ${pct(x.consensusProbability?.home)}%
X: ${pct(x.consensusProbability?.draw)}%
П2: ${pct(x.consensusProbability?.away)}%

Расчёт объединяет модели с весом по их качеству.`,

    Fair:
      `<b>Fair Odds: ${Number.isFinite(b.fairOdds) ? b.fairOdds.toFixed(2) : "N/A"}</b>
Справедливый коэффициент модели.

1 / ${pct(b.probability)}%
= <b>${Number.isFinite(b.fairOdds) ? b.fairOdds.toFixed(2) : "N/A"}</b>`,

    Edge:
      `<b>Edge: ${n1(b.edge)} п.п.</b>
Перевес модели над рыночной вероятностью.

Model: ${pct(b.probability)}%
Рынок без маржи: ${pct(b.marketFair)}%

${pct(b.probability)} − ${pct(b.marketFair)}
= <b>${n1(b.edge)} п.п.</b>`,

    EV:
      `<b>EV: ${n1(b.ev)}%</b>
Ожидаемая математическая доходность.

Model: ${pct(b.probability)}%
Коэффициент: ${b.odds ?? "N/A"}

(${n1((b.probability ?? 0)*100)}% × ${b.odds ?? "N/A"}) − 1
= <b>${n1(b.ev)}%</b>`,

    Conf:
      `<b>Confidence: ${b.confidence ?? "N/A"}/100</b>

DQ: +${cp.dataQuality ?? "N/A"}
Consensus: +${cp.consensus ?? "N/A"}
Stability: +${cp.stability ?? "N/A"}
MAI: +${cp.marketAgreement ?? "N/A"}
База: +${cp.base ?? 15}
Red Flags: −${cp.redFlagPenalty ?? 0}

<b>Итого: ${b.confidence ?? "N/A"}/100</b>`,

    FDS:
      `<b>FDS: ${b.fds ?? "N/A"}/100</b>
Итоговый рейтинг решения.

Edge: +${fp.edge ?? "N/A"}
EV: +${fp.ev ?? "N/A"}
Confidence: +${fp.confidence ?? "N/A"}
DQ: +${fp.dataQuality ?? "N/A"}
Stability: +${fp.stability ?? "N/A"}

Raw FDS: ${b.rawFds ?? "N/A"}/100
Лимит качества: ${b.fdsCap ?? "N/A"}/100

<b>Финальный FDS: ${b.fds ?? "N/A"}/100</b>`
  };

  return texts[code] || "Описание не найдено.";
}

export function backKeyboard(){ return kb([[{text:"⬅️ Dashboard",callback_data:"dashboard"}]]); }
