import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LOGS_DIR = path.join(ROOT, "logs");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const DENIED_LOG = path.join(LOGS_DIR, "denied-access.log");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN?.trim();
const ODDS_KEY = process.env.THE_ODDS_API_KEY?.trim() || "";
const ODDS_REGION = process.env.ODDS_REGION?.trim() || "eu";
const MIN_EDGE = Number(process.env.MIN_EDGE_PERCENT || 4);
const MIN_DQ = Number(process.env.MIN_DATA_QUALITY || 65);
const REFRESH_MS = Math.max(5, Number(process.env.REFRESH_MINUTES || 30)) * 60_000;
const LOG_DENIED = (process.env.LOG_DENIED_ACCESS || "true").toLowerCase() === "true";
const REQUEST_TIMEOUT_MS = Math.max(5, Number(process.env.REQUEST_TIMEOUT_SECONDS || 20)) * 1000;
const rawAllowedIds = (process.env.ALLOWED_CHAT_IDS || "").trim();

if (!TG_TOKEN || TG_TOKEN.startsWith("PASTE_")) {
  console.error("Ошибка: добавьте TELEGRAM_BOT_TOKEN в файл .env");
  process.exit(1);
}
if (!FD_TOKEN || FD_TOKEN.startsWith("PASTE_")) {
  console.error("Ошибка: добавьте FOOTBALL_DATA_TOKEN в файл .env");
  process.exit(1);
}
if (!rawAllowedIds) {
  console.error("Ошибка: заполните ALLOWED_CHAT_IDS в файле .env");
  console.error("Чтобы узнать свой chat_id, временно запустите отдельного тестового бота или добавьте значение вручную.");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const allowedIds = new Set(
  rawAllowedIds
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
);

let offset = 0;
let state = {
  updatedAt: null,
  loading: false,
  fixtures: [],
  value: [],
  near: [],
  wait: [],
  rejected: [],
  errors: []
};

const SPORT_KEYS = {
  PL: "soccer_epl",
  PD: "soccer_spain_la_liga",
  BL1: "soccer_germany_bundesliga",
  SA: "soccer_italy_serie_a",
  FL1: "soccer_france_ligue_one",
  CL: "soccer_uefa_champs_league",
  EL: "soccer_uefa_europa_league",
  DED: "soccer_netherlands_eredivisie",
  PPL: "soccer_portugal_primeira_liga",
  ELC: "soccer_efl_champ",
  BSA: "soccer_brazil_campeonato"
};

function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text.slice(0, 220)}`);
    }
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function tg(method, body = {}) {
  return request(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then(data => {
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  });
}

function isAllowed(chatId) {
  return allowedIds.has(String(chatId));
}

function logDenied(update) {
  if (!LOG_DENIED) return;
  const chat = update.message?.chat || update.callback_query?.message?.chat || {};
  const user = update.message?.from || update.callback_query?.from || {};
  fs.appendFileSync(
    DENIED_LOG,
    JSON.stringify({
      time: new Date().toISOString(),
      chat_id: chat.id ?? null,
      username: user.username ?? null,
      input: update.message?.text ?? update.callback_query?.data ?? null
    }) + "\n",
    "utf8"
  );
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchFixtures() {
  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 3600_000);
  const url = new URL("https://api.football-data.org/v4/matches");
  url.searchParams.set("dateFrom", dateOnly(now));
  url.searchParams.set("dateTo", dateOnly(horizon));

  const data = await request(url, {
    headers: { "X-Auth-Token": FD_TOKEN }
  });

  return (data.matches || [])
    .filter(m => ["SCHEDULED", "TIMED"].includes(m.status))
    .filter(m => {
      const kickoff = new Date(m.utcDate);
      return kickoff > now && kickoff <= horizon;
    })
    .map(m => ({
      id: String(m.id),
      competitionCode: m.competition?.code,
      competition: m.competition?.name || "Unknown",
      utcDate: m.utcDate,
      home: m.homeTeam?.name || "Home",
      away: m.awayTeam?.name || "Away",
      homeId: m.homeTeam?.id,
      awayId: m.awayTeam?.id,
      matchday: m.matchday
    }));
}

async function fetchCompetitionContext(code) {
  if (!code) return null;
  try {
    const [standings, matches] = await Promise.all([
      request(`https://api.football-data.org/v4/competitions/${code}/standings`, {
        headers: { "X-Auth-Token": FD_TOKEN }
      }),
      request(`https://api.football-data.org/v4/competitions/${code}/matches?status=FINISHED`, {
        headers: { "X-Auth-Token": FD_TOKEN }
      })
    ]);
    return {
      standings,
      matches: (matches.matches || []).slice(-300)
    };
  } catch (error) {
    state.errors.push(`${code}: ${error.message}`);
    return null;
  }
}

function teamRow(context, teamId) {
  const table = context?.standings?.standings?.find(s => s.type === "TOTAL")?.table || [];
  return table.find(row => row.team?.id === teamId);
}

function recentForm(context, teamId, limit = 5) {
  const games = (context?.matches || [])
    .filter(m => m.homeTeam?.id === teamId || m.awayTeam?.id === teamId)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, limit);

  let points = 0;
  let gf = 0;
  let ga = 0;

  for (const match of games) {
    const isHome = match.homeTeam.id === teamId;
    const scored = Number(isHome ? match.score.fullTime.home : match.score.fullTime.away) || 0;
    const conceded = Number(isHome ? match.score.fullTime.away : match.score.fullTime.home) || 0;
    gf += scored;
    ga += conceded;
    if (scored > conceded) points += 3;
    else if (scored === conceded) points += 1;
  }
  return { games: games.length, points, gf, ga };
}

function softmax3(home, draw, away) {
  const values = [home, draw, away];
  const max = Math.max(...values);
  const exp = values.map(v => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / sum);
}

function buildModel(fixture, context) {
  const home = teamRow(context, fixture.homeId);
  const away = teamRow(context, fixture.awayId);
  const homeForm = recentForm(context, fixture.homeId);
  const awayForm = recentForm(context, fixture.awayId);

  if (!home || !away || homeForm.games < 3 || awayForm.games < 3) {
    return {
      ...fixture,
      dataQuality: 48,
      category: "wait",
      reason: "Недостаточно данных таблицы или свежей формы.",
      model: null
    };
  }

  const hp = Math.max(home.playedGames || 1, 1);
  const ap = Math.max(away.playedGames || 1, 1);
  const ppgH = home.points / hp;
  const ppgA = away.points / ap;
  const gdH = home.goalDifference / hp;
  const gdA = away.goalDifference / ap;
  const formH = homeForm.points / (homeForm.games * 3);
  const formA = awayForm.points / (awayForm.games * 3);

  const strength =
    (ppgH - ppgA) * 0.65 +
    (gdH - gdA) * 0.22 +
    (formH - formA) * 0.75;

  const [pHome, pDraw, pAway] = softmax3(
    0.28 + strength,
    0.05 - Math.abs(strength) * 0.28,
    -strength
  );

  const avgGoalsH = (home.goalsFor + home.goalsAgainst) / hp;
  const avgGoalsA = (away.goalsFor + away.goalsAgainst) / ap;
  const expectedGoals = Math.max(1.4, Math.min(4.0, (avgGoalsH + avgGoalsA) / 2));

  const dataQuality = Math.round(
    Math.min(82, 55 + Math.min(hp, ap) * 0.7 + Math.min(homeForm.games, awayForm.games) * 2)
  );

  return {
    ...fixture,
    dataQuality,
    model: {
      home: pHome,
      draw: pDraw,
      away: pAway,
      expectedGoals,
      components: { ppgH, ppgA, gdH, gdA, formH, formA }
    }
  };
}

async function fetchOddsForSport(sportKey) {
  if (!ODDS_KEY || !sportKey) return [];
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`);
  url.searchParams.set("apiKey", ODDS_KEY);
  url.searchParams.set("regions", ODDS_REGION);
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "decimal");

  try {
    return await request(url);
  } catch (error) {
    state.errors.push(`Odds ${sportKey}: ${error.message}`);
    return [];
  }
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9а-яё]/gi, "")
    .replace(/fc|cf|afc|club|calcio|football/g, "");
}

function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const chars = new Set(x);
  let common = 0;
  for (const c of y) if (chars.has(c)) common++;
  return common / Math.max(x.length, y.length, 1);
}

function findOddsEvent(fixture, events) {
  return events.find(event =>
    similarity(fixture.home, event.home_team) > 0.58 &&
    similarity(fixture.away, event.away_team) > 0.58
  );
}

function bestH2H(event) {
  if (!event) return null;
  let best = null;

  for (const book of event.bookmakers || []) {
    const market = book.markets?.find(m => m.key === "h2h");
    if (!market) continue;

    const values = {};
    for (const outcome of market.outcomes || []) {
      values[outcome.name] = outcome.price;
    }

    const row = {
      bookmaker: book.title,
      home: values[event.home_team],
      draw: values.Draw,
      away: values[event.away_team]
    };

    if (!row.home || !row.draw || !row.away) continue;
    const score = row.home + row.draw + row.away;
    const bestScore = best ? best.home + best.draw + best.away : 0;
    if (!best || score > bestScore) best = row;
  }
  return best;
}

function removeMargin(odds) {
  if (!odds) return null;
  const raw = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const total = raw.reduce((a, b) => a + b, 0);
  return {
    home: raw[0] / total,
    draw: raw[1] / total,
    away: raw[2] / total
  };
}

function classify(item, event) {
  if (!item.model || item.dataQuality < MIN_DQ) {
    return {
      ...item,
      category: "wait",
      reason: item.reason || "Data Quality ниже рабочего порога."
    };
  }

  const odds = bestH2H(event);
  if (!odds) {
    return {
      ...item,
      category: "wait",
      reason: "Коэффициенты не найдены. Нельзя подтвердить value.",
      odds: null
    };
  }

  const market = removeMargin(odds);
  const candidates = [
    { side: "П1", key: "home", probability: item.model.home, odds: odds.home },
    { side: "X", key: "draw", probability: item.model.draw, odds: odds.draw },
    { side: "П2", key: "away", probability: item.model.away, odds: odds.away }
  ].map(candidate => ({
    ...candidate,
    edge: (candidate.probability - market[candidate.key]) * 100,
    ev: (candidate.probability * candidate.odds - 1) * 100,
    fairOdds: 1 / candidate.probability
  })).sort((a, b) => b.edge - a.edge);

  const best = candidates[0];
  const confidence = Math.round(
    Math.min(88, item.dataQuality * 0.55 + Math.max(0, best.edge) * 2.4 + 18)
  );

  const result = {
    ...item,
    odds,
    bookmaker: odds.bookmaker,
    marketProbability: market,
    candidate: best,
    confidence
  };

  if (best.edge >= MIN_EDGE && best.ev >= 4 && confidence >= 70) {
    return { ...result, category: "value" };
  }

  if (best.edge >= Math.max(1.5, MIN_EDGE - 2)) {
    return {
      ...result,
      category: "near",
      reason: `Не прошли все пороги: Edge ${best.edge.toFixed(1)}%, EV ${best.ev.toFixed(1)}%, Confidence ${confidence}.`
    };
  }

  return {
    ...result,
    category: "rejected",
    reason: "Преимущество над рынком недостаточно."
  };
}

function saveCache() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    state = { ...state, ...cached, loading: false };
  } catch (error) {
    console.warn("Не удалось прочитать cache.json:", error.message);
  }
}

async function refreshData() {
  if (state.loading) return;
  state.loading = true;
  state.errors = [];

  try {
    const fixtures = await fetchFixtures();
    const competitionCodes = [...new Set(fixtures.map(f => f.competitionCode).filter(Boolean))];

    const contexts = {};
    for (const code of competitionCodes) {
      contexts[code] = await fetchCompetitionContext(code);
    }

    const oddsByCode = {};
    for (const code of competitionCodes) {
      const sportKey = SPORT_KEYS[code];
      if (sportKey) oddsByCode[code] = await fetchOddsForSport(sportKey);
    }

    const processed = fixtures.map(fixture => {
      const modelled = buildModel(fixture, contexts[fixture.competitionCode]);
      const oddsEvent = findOddsEvent(
        fixture,
        oddsByCode[fixture.competitionCode] || []
      );
      return classify(modelled, oddsEvent);
    });

    state.fixtures = processed;
    state.value = processed.filter(x => x.category === "value");
    state.near = processed.filter(x => x.category === "near");
    state.wait = processed.filter(x => x.category === "wait");
    state.rejected = processed.filter(x => x.category === "rejected");
    state.updatedAt = new Date().toISOString();

    saveCache();

    console.log(
      `Обновлено ${processed.length} матчей | VALUE ${state.value.length} | Near ${state.near.length} | WAIT ${state.wait.length} | NO BET ${state.rejected.length}`
    );
  } catch (error) {
    state.errors.push(error.message);
    console.error("Refresh error:", error.message);
    saveCache();
  } finally {
    state.loading = false;
  }
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

function mainKeyboard() {
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

function dashboardText() {
  const modelled = state.value.length + state.near.length + state.rejected.length;
  const oddsMode = ODDS_KEY ? "реальные коэффициенты" : "без Odds API";

  return [
    "<b>FVM v0.4 - REAL DATA</b>",
    "",
    state.loading ? "Статус: обновление" : "Статус: готово",
    `Обновлено: <b>${state.updatedAt ? new Date(state.updatedAt).toLocaleString("ru-RU") : "еще нет"}</b>`,
    `Рынок: <b>${oddsMode}</b>`,
    "",
    `Матчей на 24 часа: <b>${state.fixtures.length}</b>`,
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
  const body = {
    chat_id: chatId,
    text: dashboardText(),
    parse_mode: "HTML",
    reply_markup: mainKeyboard()
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
  return [
    "<b>FVM status</b>",
    "",
    `Рабочая папка: <code>${esc(ROOT)}</code>`,
    `Telegram token: <b>${TG_TOKEN ? "есть" : "нет"}</b>`,
    `Football-data token: <b>${FD_TOKEN ? "есть" : "нет"}</b>`,
    `Odds API: <b>${ODDS_KEY ? "подключен" : "не подключен"}</b>`,
    `Allowed chat ids: <b>${allowedIds.size}</b>`,
    `Refresh: <b>${Math.round(REFRESH_MS / 60_000)} мин.</b>`,
    `Timeout: <b>${REQUEST_TIMEOUT_MS / 1000} сек.</b>`,
    "",
    `Последнее обновление: <b>${state.updatedAt ? new Date(state.updatedAt).toLocaleString("ru-RU") : "еще нет"}</b>`,
    `Матчей в кеше: <b>${state.fixtures.length}</b>`,
    `Ошибок источников: <b>${state.errors.length}</b>`,
    state.errors.length ? `\n<code>${esc(state.errors.slice(0, 5).join("\n"))}</code>` : ""
  ].join("\n");
}

function shortItem(item, index) {
  const time = new Date(item.utcDate).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });

  const detail = item.candidate
    ? `${item.candidate.side} @${item.candidate.odds} | Model ${(item.candidate.probability * 100).toFixed(0)}% | Edge ${item.candidate.edge.toFixed(1)}%`
    : item.reason;

  return `${index + 1}. <b>${esc(item.home)} - ${esc(item.away)}</b>\n${esc(item.competition)} · ${time}\n${esc(detail)}`;
}

async function showList(chatId, kind) {
  const map = {
    value: ["REAL VALUE", state.value],
    near: ["NEAR VALUE", state.near],
    wait: ["WAIT", state.wait],
    fixtures: ["Матчи на 24 часа", state.fixtures]
  };

  const [title, items] = map[kind];

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
  const item = state.fixtures.find(x => x.id === id);
  if (!item) return;

  const lines = [
    `<b>${esc(item.home)} - ${esc(item.away)}</b>`,
    esc(item.competition),
    `Начало: ${new Date(item.utcDate).toLocaleString("ru-RU")}`,
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

  if (query.data === "dashboard") {
    return sendDashboard(chatId, query.message.message_id);
  }

  if (query.data === "refresh") {
    await refreshData();
    return sendDashboard(chatId, query.message.message_id);
  }

  if (query.data === "pipeline") {
    return tg("sendMessage", {
      chat_id: chatId,
      text: [
        "<b>Pipeline v0.4</b>",
        "",
        "Готово: реальное расписание",
        "Готово: таблицы и последние результаты",
        "Готово: предварительная модель 1X2",
        ODDS_KEY ? "Готово: реальные коэффициенты" : "WAIT: Odds API не подключен",
        "Готово: удаление маржи",
        "Готово: VALUE / Near / WAIT / NO BET",
        "Дальше: xG Model",
        "Дальше: Squad/Injuries",
        "Дальше: Tactical/SCI/MAI"
      ].join("\n"),
      parse_mode: "HTML",
      reply_markup: keyboard([[{ text: "Dashboard", callback_data: "dashboard" }]])
    });
  }

  if (query.data.startsWith("list:")) {
    return showList(chatId, query.data.split(":")[1]);
  }

  if (query.data.startsWith("card:")) {
    return showCard(chatId, query.data.split(":")[1]);
  }
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

  if (text === "/start" || text === "/dashboard") {
    return sendDashboard(chatId);
  }

  if (text === "/refresh") {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Обновляю реальные данные..."
    });
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

async function poll() {
  console.log("FVM v0.4 запускается...");
  console.log(`Рабочая папка: ${ROOT}`);

  loadCache();
  await refreshData();
  setInterval(refreshData, REFRESH_MS);

  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    } catch (error) {
      console.error(new Date().toISOString(), error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

poll();
