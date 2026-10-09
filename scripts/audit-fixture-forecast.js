// Read-only forecast audit for ONE fixture, from the local SQLite (+ optionally a cached
// The Odds API file). No network, no API keys, no .env, nothing written except stdout/--out.
//
//   node scripts/audit-fixture-forecast.js --home "PSV Eindhoven" --away "Heerenveen" \
//        --kickoff 2026-10-09T18:45:00Z --code DED --season 2026 \
//        [--db data/history/football.sqlite] \
//        [--odds-cache data/market-cache/the-odds-api/DED.json] [--out run-after.json]
//
// Reproduces the SQLite-derived model path (competition baseline -> two-team local history ->
// Team Strength / Form / consensus) and reports: where lambda comes from, the 1X2 distribution,
// logical duplicate matches (same match stored under two spellings/providers), and -- with
// --odds-cache -- every bookmaker's 1X2 price, the best price, the benchmark book and the
// Edge/EV arithmetic. The live pipeline may use a mature live standings table instead of the
// SQLite baseline; this audit shows the SQLite path only.
//
// Before/after comparison: run the SAME command in a checkout of an older commit (copy this
// file into that checkout's scripts/ folder, keep --db pointing at the same SQLite) and diff
// with `node scripts/compare-forecast-runs.js before.json after.json`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getTeamLastMatches } from "../src/history/sqliteHistory.js";
import { resolveTeamStrengthBaseline } from "../src/history/competitionBaseline.js";
import { mergeWithLocalHistory } from "../src/history/localHistory.js";
import { canonicalTeamIdentity } from "../src/history/teamAliases.js";
import { alignContextTeamIds } from "../src/engine/contextIds.js";
import { teamStrengthModel, formModel, consensus } from "../src/engine/models.js";
import { evaluateMarkets } from "../src/engine/markets.js";
import { extractMarkets, matchOddsEvent } from "../src/connectors/odds.js";

const DUPLICATE_WINDOW_MS = 24 * 3600_000;
const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

// Same-match-stored-twice scan, self-contained so it also runs inside an older checkout.
function duplicateGroups(rows) {
  const clusters = new Map(), groups = [];
  for (const row of [...rows].sort((a, b) => String(a.playedAt || a.utcDate).localeCompare(String(b.playedAt || b.utcDate)))) {
    const when = row.playedAt || row.utcDate;
    const key = `${canonicalTeamIdentity(row.homeTeam?.name)}|${canonicalTeamIdentity(row.awayTeam?.name)}`;
    const time = new Date(when).getTime();
    const list = clusters.get(key) || [];
    const hit = list.find(cluster => Math.abs(cluster.time - time) < DUPLICATE_WINDOW_MS);
    if (hit) { hit.rows.push(row); continue; }
    const created = { time, rows: [row] };
    list.push(created); clusters.set(key, list); groups.push(created);
  }
  return groups.filter(group => group.rows.length > 1).map(group => ({
    playedAt: group.rows[0].playedAt || group.rows[0].utcDate,
    rows: group.rows.map(row => ({ home: row.homeTeam?.name, away: row.awayTeam?.name, source: row.provenance?.source ?? null }))
  }));
}

function teamRecord(table, id) {
  const entry = table.find(row => row.team?.id === id);
  return entry ? { played: entry.playedGames, goalsFor: entry.goalsFor, goalsAgainst: entry.goalsAgainst } : null;
}

function lambdaOrigin(context, fixture, strength) {
  const tables = type => context?.standings?.standings?.find(group => group.type === type)?.table || [];
  const total = tables("TOTAL");
  const leagueGames = total.reduce((sum, row) => sum + (Number(row.playedGames) || 0), 0);
  const leagueGoals = total.reduce((sum, row) => sum + (Number(row.goalsFor) || 0), 0);
  return {
    leagueGoalsPerTeamGame: round(leagueGames ? leagueGoals / leagueGames : 1.35),
    leagueRows: total.length,
    homeTeamAtHome: teamRecord(tables("HOME"), fixture.homeId) || "fallback: TOTAL row",
    awayTeamAway: teamRecord(tables("AWAY"), fixture.awayId) || "fallback: TOTAL row",
    homeTeamTotal: teamRecord(total, fixture.homeId),
    awayTeamTotal: teamRecord(total, fixture.awayId),
    lambda: strength ? { home: round(strength.lambdas.home), away: round(strength.lambdas.away) } : null
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function priceTable(oddsData) {
  const out = {};
  for (const side of ["home", "draw", "away"]) {
    const prices = oddsData.bookmakers.map(book => ({ bookmaker: book.name, odds: book.h2h?.[side] })).filter(entry => Number.isFinite(entry.odds));
    const ranked = [...prices].sort((a, b) => b.odds - a.odds);
    const mid = median(prices.map(entry => entry.odds));
    out[side] = {
      bookmakers: prices.length, best: ranked[0] || null, second: ranked[1] || null, median: round(mid, 3),
      bestVsMedianPct: ranked[0] && mid ? round((ranked[0].odds / mid - 1) * 100, 1) : null,
      bestVsSecondPct: ranked[0] && ranked[1] ? round((ranked[0].odds / ranked[1].odds - 1) * 100, 1) : null,
      all: ranked.map(entry => `${entry.bookmaker}=${entry.odds}`)
    };
  }
  return out;
}

export function auditFixtureForecast(db, fixtureInput, { season = null, oddsEvents = null } = {}) {
  const fixture = {
    id: "audit", ...fixtureInput, homeId: fixtureInput.homeId ?? -1, awayId: fixtureInput.awayId ?? -2,
    seasonStart: fixtureInput.seasonStart || season || String(new Date(fixtureInput.utcDate).getUTCFullYear())
  };
  const rawContext = { standings: null, finished: [], scheduled: [] };
  const history = [...new Map([
    ...getTeamLastMatches(db, { name: fixture.home }, fixture.utcDate, 20),
    ...getTeamLastMatches(db, { name: fixture.away }, fixture.utcDate, 20)
  ].map(row => [row.recordKey, row])).values()];
  const { baseContext, competitionBaseline, rawBaseline } = resolveTeamStrengthBaseline(db, rawContext, fixture, alignContextTeamIds, fixture.utcDate);
  const context = mergeWithLocalHistory(baseContext, history, fixture);
  const strength = teamStrengthModel(fixture, context);
  const form = formModel(fixture, context);
  const cons = consensus([strength, form]);
  const report = {
    fixture: { home: fixture.home, away: fixture.away, utcDate: fixture.utcDate, competitionCode: fixture.competitionCode || null },
    historyRows: { total: history.length, logicalDuplicateGroups: duplicateGroups(history) },
    baseline: competitionBaseline
      ? { tier: competitionBaseline.baselineSource, sample: competitionBaseline.baselineSample, teams: competitionBaseline.baselineTeams,
          logicalDuplicateGroups: duplicateGroups(
            fixture.competitionCode ? getBaselineRows(db, fixture) : []) }
      : { tier: "NONE", sampleCurrentSeason: rawBaseline?.sampleCurrentSeason ?? 0, samplePreviousSeason: rawBaseline?.samplePreviousSeason ?? 0 },
    lambdaOrigin: lambdaOrigin(context, fixture, strength),
    models: {
      teamStrength: strength ? { probability: roundProbabilities(strength.probability), lambdas: strength.lambdas, quality: strength.quality } : null,
      form: form ? { probability: roundProbabilities(form.probability), quality: form.quality, explanation: form.explanation } : null,
      consensus: cons ? { probability: roundProbabilities(cons.probability), agreement: cons.agreement, modelsAvailable: cons.modelsAvailable } : null
    },
    market: null
  };
  if (oddsEvents && cons && strength) {
    const event = matchOddsEvent(fixture, oddsEvents);
    if (event) {
      const oddsData = extractMarkets(event);
      const rows = evaluateMarkets(fixture, strength, cons, oddsData).filter(row => row.market === "1X2");
      report.market = {
        event: { home: event.home_team, away: event.away_team, commence: event.commence_time },
        bookmakers: oddsData.bookmakers.length,
        benchmark: oddsData.benchmark?.h2h ? { bookmaker: oddsData.benchmark.h2h.bookmaker, overround: round(oddsData.benchmark.h2h.overround) } : null,
        prices: priceTable(oddsData),
        candidates: rows.map(row => ({
          label: row.label, modelProbability: round(row.probability), fairOdds: round(row.fairOdds, 2),
          bestOdds: row.bestOdds, bestBookmaker: row.bestBookmaker, benchmarkBookmaker: row.benchmarkBookmaker,
          benchmarkNoVigProbability: round(row.marketFair), edgePp: round(row.edge, 2), evPct: round(row.ev, 2),
          // EV uses the best price of ANY book, Edge uses the benchmark book's no-vig probability.
          evFromEdgeParts: round((row.probability * row.bestOdds - 1) * 100, 2),
          bestOddsVsBenchmarkFairPct: round((row.bestOdds * row.marketFair - 1) * 100, 2)
        }))
      };
    } else report.market = { event: null, reason: "no matching event in the odds cache" };
  }
  return report;
}

function getBaselineRows(db, fixture) {
  const year = String(fixture.seasonStart).slice(0, 4);
  return db.prepare("SELECT homeTeam, awayTeam, kickoff, source FROM matches WHERE (competitionCode=? OR competition=?) AND substr(season,1,4)=? AND kickoff < ?")
    .all(fixture.competitionCode, fixture.competitionCode, year, new Date(fixture.utcDate).toISOString())
    .map(row => ({ homeTeam: { name: row.homeTeam }, awayTeam: { name: row.awayTeam }, playedAt: row.kickoff, provenance: { source: row.source } }));
}

function roundProbabilities(probability) {
  return { home: round(probability.home), draw: round(probability.draw), away: round(probability.away) };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => {
    if (value.startsWith("--")) out.push([value.slice(2), all[index + 1]]);
    return out;
  }, []));
  if (!args.home || !args.away || !args.kickoff) {
    console.error('usage: node scripts/audit-fixture-forecast.js --home "<team>" --away "<team>" --kickoff <ISO> [--code DED] [--season 2026] [--db <file>] [--odds-cache <file>] [--out <file>]');
    process.exit(2);
  }
  const dbFile = path.resolve(args.db || "data/history/football.sqlite");
  if (!fs.existsSync(dbFile)) { console.error(`SQLite file not found: ${dbFile}`); process.exit(2); }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let oddsEvents = null;
  if (args["odds-cache"]) oddsEvents = JSON.parse(fs.readFileSync(path.resolve(args["odds-cache"]), "utf8")).events || [];
  try {
    const report = auditFixtureForecast(db, {
      home: args.home, away: args.away, competitionCode: args.code || "", utcDate: new Date(args.kickoff).toISOString()
    }, { season: args.season || null, oddsEvents });
    const text = JSON.stringify(report, null, 2);
    if (args.out) fs.writeFileSync(path.resolve(args.out), text, "utf8"); else console.log(text);
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
