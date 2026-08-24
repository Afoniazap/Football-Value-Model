import { similarity } from "../engine/utils.js";

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
  BSA: "soccer_brazil_campeonato",
  MLS: "soccer_usa_mls",
  CLI: "soccer_conmebol_copa_libertadores",
  SUD: "soccer_conmebol_copa_sudamericana",
  LEAGUES: "soccer_concacaf_leagues_cup",
  BSB: "soccer_brazil_serie_b",
};

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`odds ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function getOddsForCompetition(apiKey, region, competitionCode) {
  const sport = SPORT_KEYS[competitionCode];
  if (!apiKey || !sport) return [];
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", region);
  url.searchParams.set("markets", "h2h,spreads,totals");
  url.searchParams.set("oddsFormat", "decimal");
  return getJson(url);
}

export function matchOddsEvent(fixture, events) {
  return events.find(e =>
    similarity(fixture.home, e.home_team) >= 0.62 &&
    similarity(fixture.away, e.away_team) >= 0.62
  ) || null;
}

function outcomeMap(market) {
  return Object.fromEntries((market?.outcomes || []).map(x => [
    `${x.name}|${x.point ?? ""}`, x.price
  ]));
}

export function extractMarkets(event) {
  if (!event) return { bookmakers: [], best: {}, agreement: null };
  const books = [];
  for (const book of event.bookmakers || []) {
    const h2h = book.markets?.find(m => m.key === "h2h");
    const spreads = book.markets?.find(m => m.key === "spreads");
    const totals = book.markets?.find(m => m.key === "totals");
    const h = outcomeMap(h2h), s = outcomeMap(spreads), t = outcomeMap(totals);
    books.push({
      name: book.title,
      lastUpdate: book.last_update,
      h2h: {
        home: h[`${event.home_team}|`],
        draw: h["Draw|"],
        away: h[`${event.away_team}|`]
      },
      spreads: (spreads?.outcomes || []).map(x => ({ name: x.name, point: x.point, odds: x.price })),
      totals: (totals?.outcomes || []).map(x => ({ name: x.name, point: x.point, odds: x.price }))
    });
  }

  const best = { h2h: {}, spreads: {}, totals: {} };
  for (const b of books) {
    for (const side of ["home", "draw", "away"]) {
      if (b.h2h[side] && (!best.h2h[side] || b.h2h[side] > best.h2h[side].odds)) {
        best.h2h[side] = { odds: b.h2h[side], bookmaker: b.name };
      }
    }
    for (const x of b.spreads) {
      const key = `${x.name}|${x.point}`;
      if (!best.spreads[key] || x.odds > best.spreads[key].odds) {
        best.spreads[key] = { odds: x.odds, bookmaker: b.name, point: x.point, name: x.name };
      }
    }
    for (const x of b.totals) {
      const key = `${x.name}|${x.point}`;
      if (!best.totals[key] || x.odds > best.totals[key].odds) {
        best.totals[key] = { odds: x.odds, bookmaker: b.name, point: x.point, name: x.name };
      }
    }
  }

  const homeOdds = books.map(b => b.h2h.home).filter(Number.isFinite);
  const awayOdds = books.map(b => b.h2h.away).filter(Number.isFinite);
  const variation = values => {
    if (values.length < 2) return null;
    const mean = values.reduce((a,b)=>a+b,0)/values.length;
    const sd = Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length);
    return sd/mean;
  };
  const vars = [variation(homeOdds), variation(awayOdds)].filter(Number.isFinite);
  const avgVar = vars.length ? vars.reduce((a,b)=>a+b,0)/vars.length : null;
  const agreement = avgVar === null ? null : Math.round(Math.max(0, Math.min(100, 100 - avgVar * 500)));

  return { bookmakers: books, best, agreement };
}
