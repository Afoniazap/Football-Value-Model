import { localDate } from "../engine/utils.js";

function esc(s="") { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function kb(rows) { return {inline_keyboard:rows}; }

export function dashboardText(state) {
  const total = state.results.length;
  const counts = Object.fromEntries(["VALUE","NEAR","WAIT","NO_BET"].map(k=>[k,state.results.filter(x=>x.category===k).length]));
  const processedMarkets = state.results.reduce((s,x)=>s+x.markets.length,0);
  const health = total ? Math.round(state.results.reduce((s,x)=>s+x.dataQuality,0)/total) : 0;
  const opportunity = total ? Math.round(Math.min(100,(counts.VALUE*20+counts.NEAR*8)/total*100)) : 0;
  return [
    "⚽ <b>FOOTBALL VALUE MODEL v1.0</b>",
    "",
    state.loading ? "🟡 Анализ выполняется" : "🟢 Анализ завершён",
    `Pipeline: <b>${state.loading ? state.stage : "9/9 Complete"}</b>`,
    "",
    `Health Score: <b>${health}/100</b>`,
    `Opportunity Index: <b>${opportunity}/100</b>`,
    "",
    `Матчей на 24 часа: <b>${total}</b>`,
    `Рынков рассчитано: <b>${processedMarkets}</b>`,
    `✅ VALUE: <b>${counts.VALUE}</b>`,
    `🟡 Near Value: <b>${counts.NEAR}</b>`,
    `🟠 WAIT: <b>${counts.WAIT}</b>`,
    `❌ NO BET: <b>${counts.NO_BET}</b>`,
    "",
    `Обновлено: <b>${state.updatedAt ? localDate(state.updatedAt) : "—"}</b>`,
    state.errors.length ? `⚠️ Ошибок источников: <b>${state.errors.length}</b>` : "Источники: ✅"
  ].join("\n");
}

export function dashboardKeyboard(state) {
  const count = k => state.results.filter(x=>x.category===k).length;
  return kb([
    [{text:`🎯 VALUE (${count("VALUE")})`,callback_data:"list:VALUE"},
     {text:`👀 Near (${count("NEAR")})`,callback_data:"list:NEAR"}],
    [{text:`⏳ WAIT (${count("WAIT")})`,callback_data:"list:WAIT"},
     {text:`❌ NO BET (${count("NO_BET")})`,callback_data:"list:NO_BET"}],
    [{text:"⚙️ Pipeline",callback_data:"pipeline"},
     {text:"🔄 Обновить",callback_data:"refresh"}]
  ]);
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
  const rows=items.slice(0,20).map(x=>[{text:`${x.home.slice(0,12)} — ${x.away.slice(0,12)} · ${localDate(x.utcDate)}`,callback_data:`card:${x.id}`}]);
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
  const p=x.consensusProbability;
  const lines=[
    `<b>${esc(x.home)} — ${esc(x.away)}</b>`,
    `${esc(x.competition)} · ${localDate(x.utcDate)}`,
    "",
    `Статус: <b>${x.category}</b>`,
    `Тип матча: ${esc(x.classification)}`,
    `DQ: <b>${x.dataQuality}/100</b> — данные`,
    `Stab: <b>${x.stability}/100</b> — устойчивость`,
    `Cons: <b>${x.consensusScore}/100</b> — согласие`,
    `MAI: <b>${x.marketAgreement ?? "N/A"}</b> — рынок`,
    `SCI: <b>${x.sci?.score ?? "N/A"}</b> — контекст`
  ];
  if(p) lines.push("",`Модель 1X2: П1 ${(p.home*100).toFixed(1)}% · X ${(p.draw*100).toFixed(1)}% · П2 ${(p.away*100).toFixed(1)}%`);
  if(x.best) lines.push(
    "",
    `Лучший рынок: <b>${esc(x.best.market)} — ${esc(x.best.label)}</b>`,
    `Коэффициент: <b>${x.best.odds}</b> (${esc(x.best.bookmaker)})`,
    `Model: <b>${(x.best.probability*100).toFixed(1)}%</b>`,
    `Fair Odds: <b>${x.best.fairOdds.toFixed(2)}</b>`,
    `Edge: <b>${x.best.edge.toFixed(1)} п.п.</b>`,
    `EV: <b>${x.best.ev.toFixed(1)}%</b>`,
    `Conf: <b>${x.best.confidence}/100</b> — уверенность`,
    `FDS: <b>${x.best.fds}/100</b> — итог`
  );
  if (x.best) {
    const gates = [
      { name: "Edge", value: x.best.edge, threshold: 4, unit: " п.п." },
      { name: "EV", value: x.best.ev, threshold: 5, unit: "%" },
      { name: "Confidence", value: x.best.confidence, threshold: 70, unit: "" },
      { name: "Data Quality", value: x.dataQuality, threshold: 70, unit: "" },
      { name: "Stability", value: x.stability, threshold: 70, unit: "" }
    ];

    const failed = gates.filter(g => g.value < g.threshold);

    lines.push(
      "",
      "<b>VALUE Gates</b>",
      ...gates.map(g => gateLine(g.name, Number(g.value.toFixed ? g.value.toFixed(1) : g.value), g.threshold, g.unit)),
      "",
      `Пройдено условий: <b>${gates.length - failed.length}/${gates.length}</b>`
    );

    if (failed.length) {
      const worst = failed
        .map(g => ({ ...g, gap: g.threshold - g.value }))
        .sort((a,b) => b.gap - a.gap)[0];

      lines.push(
        `Главный блокер: 🔴 <b>${worst.name}</b> — не хватает ${worst.gap.toFixed(1)}${worst.unit}`
      );
    }

    if (x.best.probability >= 0.90 && x.dataQuality < 70) {
      lines.push(
        "",
        "⚠️ <b>Probability sanity check</b>",
        "Очень высокая модельная вероятность при низком Data Quality. Требуется дополнительная проверка."
      );
    }
  }

  lines.push("",`Решение: ${esc(x.reason)}`);
  if(x.redFlags.length) lines.push(`Red Flags: ${esc(x.redFlags.join("; "))}`);
  lines.push("","Модели:",...x.models.map(m=>`• ${esc(m.name)} (${m.quality}): ${esc(m.explanation)}`));
  return lines.join("\n");
}


export function metricKeyboard(x){
  const b = x.best || {};

  const gate = (name, value, threshold, code) => ({
    text: `${Number(value) >= threshold ? "🟢" : "🔴"} ${name} ${Number.isFinite(Number(value)) ? Number(value).toFixed(0) : "?"}`,
    callback_data: `metric:${code}:${x.id}`
  });

  return kb([
    [
      gate("Edge", b.edge, 4, "Edge"),
      gate("EV", b.ev, 5, "EV"),
      gate("Conf", b.confidence, 70, "Conf"),
      gate("DQ", x.dataQuality, 70, "DQ"),
      gate("Stab", x.stability, 70, "Stab")
    ],
    [
      {text:`Cons ${x.consensusScore ?? "?"}`,callback_data:`metric:Cons:${x.id}`},
      {text:`MAI ${x.marketAgreement ?? "?"}`,callback_data:`metric:MAI:${x.id}`},
      {text:`SCI ${x.sci?.score ?? "?"}`,callback_data:`metric:SCI:${x.id}`}
    ],
    [
      {text:`Model ${Number.isFinite(b.probability) ? (b.probability*100).toFixed(1)+"%" : "?"}`,callback_data:`metric:Model:${x.id}`},
      {text:`Fair ${Number.isFinite(b.fairOdds) ? b.fairOdds.toFixed(2) : "?"}`,callback_data:`metric:Fair:${x.id}`}
    ],
    [
      {text:`FDS ${b.fds ?? "?"}`,callback_data:`metric:FDS:${x.id}`}
    ],
    [
      {text:"⬅️ Dashboard",callback_data:"dashboard"}
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
      `<b>Model: ${pct(b.probability)}%</b>
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
