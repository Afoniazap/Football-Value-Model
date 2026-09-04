import { similarity } from "../engine/utils.js";
import fs from "node:fs";
import path from "node:path";

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

function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data),"utf8");}

export async function getOddsForCompetitionResult(apiKey,region,competitionCode,{cacheDir,cacheMinutes=15}={}){
  const sport=SPORT_KEYS[competitionCode];
  if(!apiKey)return {status:"NOT_CONFIGURED",events:[],reason:"KEY_NOT_CONFIGURED",requests:0,cacheHits:0};
  if(!sport)return {status:"NOT_SUPPORTED",events:[],reason:"COMPETITION_NOT_MAPPED",requests:0,cacheHits:0};
  const backoffFile=cacheDir?path.join(cacheDir,"quota-backoff.json"):null,backoff=backoffFile?read(backoffFile):null;
  if(Number(backoff?.until)>Date.now())return {status:"QUOTA",events:[],reason:"QUOTA_BACKOFF",requests:0,cacheHits:0};
  const cacheFile=cacheDir?path.join(cacheDir,`${competitionCode}.json`):null,cached=cacheFile?read(cacheFile):null;
  if(cached&&Date.now()-Number(cached.fetchedAt)<=cacheMinutes*60_000)return {status:"OK",events:cached.events||[],reason:null,requests:0,cacheHits:1};
  try{
    const events=await getOddsForCompetition(apiKey,region,competitionCode);
    if(cacheFile)write(cacheFile,{fetchedAt:Date.now(),events});
    return {status:events.length?"OK":"NO_ODDS",events,reason:events.length?null:"EMPTY_RESPONSE",requests:1,cacheHits:0};
  }catch(error){
    const quota=/odds 429|quota|usage limit/i.test(error.message);
    if(quota&&backoffFile)write(backoffFile,{until:Date.now()+24*3600_000,reason:"QUOTA"});
    return {status:quota?"QUOTA":"ERROR",events:[],reason:quota?"QUOTA":error.message,requests:1,cacheHits:0};
  }
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

function overround(prices) {
  if(!prices.every(odds=>Number.isFinite(odds)&&odds>1))return null;
  const margin=prices.reduce((sum, odds) => sum + 1 / odds, 0)-1;
  return margin>=-1e-9?margin:null;
}
function preferredBenchmark(current,margin,bookmaker){return margin!==null&&(!current||margin<current.overround||(margin===current.overround&&String(bookmaker).localeCompare(String(current.bookmaker))<0));}

// A "benchmark" market is a complete, single-bookmaker snapshot (same book, same
// event, same market, same line) used ONLY to derive a coherent no-vig fair
// probability. It is kept separate from `best` (best executable price per side,
// which may legitimately come from different bookmakers) so Edge/EV can still use
// the best price while Fair/Edge comparisons never mix two different books' lines.
// Among bookmakers offering a complete market, the one with the lowest overround is
// selected (an explicit, deterministic rule - not an existing bookmaker priority).
export function computeBenchmark(books, homeTeamName, awayTeamName) {
  const benchmark = { h2h: null, totals: {}, spreads: {} };

  for (const b of books) {
    if (Number.isFinite(b.h2h.home) && Number.isFinite(b.h2h.draw) && Number.isFinite(b.h2h.away)) {
      const over = overround([b.h2h.home, b.h2h.draw, b.h2h.away]);
      if (preferredBenchmark(benchmark.h2h,over,b.name)) {
        benchmark.h2h = { bookmaker: b.name, home: b.h2h.home, draw: b.h2h.draw, away: b.h2h.away, overround: over };
      }
    }
  }

  const totalLines = new Set(books.flatMap(b => (b.totals || []).map(x => x.point)));
  for (const line of totalLines) {
    for (const b of books) {
      const over = (b.totals || []).find(x => x.name === "Over" && x.point === line);
      const under = (b.totals || []).find(x => x.name === "Under" && x.point === line);
      if (!over || !under) continue;
      const ov = overround([over.odds, under.odds]);
      if (preferredBenchmark(benchmark.totals[line],ov,b.name)) {
        benchmark.totals[line] = { bookmaker: b.name, over: over.odds, under: under.odds, point: line, overround: ov };
      }
    }
  }

  if (homeTeamName && awayTeamName) {
    const homePoints = new Set(books.flatMap(b => (b.spreads || []).filter(x => x.name === homeTeamName).map(x => x.point)));
    for (const point of homePoints) {
      for (const b of books) {
        const home = (b.spreads || []).find(x => x.name === homeTeamName && x.point === point);
        const away = (b.spreads || []).find(x => x.name === awayTeamName && x.point === -point);
        if (!home || !away) continue;
        const ov = overround([home.odds, away.odds]);
        if (preferredBenchmark(benchmark.spreads[point],ov,b.name)) {
          benchmark.spreads[point] = { bookmaker: b.name, home: home.odds, away: away.odds, point, overround: ov };
        }
      }
    }
  }

  return benchmark;
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

  const benchmark = computeBenchmark(books, event.home_team, event.away_team);

  return { bookmakers: books, best, benchmark, agreement };
}
