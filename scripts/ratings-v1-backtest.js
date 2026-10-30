// Offline chronological backtest of ratings-v1 on a COPY of football.sqlite (opened read-only).
//   node scripts/ratings-v1-backtest.js --db <football.sqlite> --out <predictions.jsonl> [--lag 12] [--params v1|trainA|legacy] [--from 2026-01-01]
// Writes only the --out file. Prints a JSON summary. Uses no API and no network.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { historyRowsToMatches } from "../src/shadow/ratings/ratingsShadow.js";
import { runChronological } from "../src/shadow/ratings/ratingsCore.js";
import { RATINGS_V1_PARAMS, RATINGS_V1_PARAMS_TRAIN_A, RATINGS_V1_0_PARAMS_LEGACY, paramsId } from "../src/shadow/ratings/ratingsParams.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
if (!args.db || !args.out) { console.error("usage: --db <football.sqlite> --out <predictions.jsonl> [--lag 12] [--params v1|trainA|legacy] [--from YYYY-MM-DD]"); process.exit(2); }
const LEAGUES = new Set(["PL", "PD", "SA", "BL1", "FL1", "DED", "PPL", "ELC", "BSA"]);
const db = new DatabaseSync(args.db, { readOnly: true });
const rows = db.prepare("SELECT kickoff playedAt, status, competitionCode, competition, homeTeam, awayTeam, homeGoals, awayGoals, source FROM matches WHERE status IN ('FT','AET','PEN','FINISHED') AND competitionCode IS NOT NULL ORDER BY kickoff").all()
  .filter(r => LEAGUES.has(r.competitionCode))
  .map(r => ({ playedAt: r.playedAt, status: r.status, competition: { code: r.competitionCode, name: r.competition }, homeTeam: { name: r.homeTeam }, awayTeam: { name: r.awayTeam }, score: { fullTime: { home: r.homeGoals, away: r.awayGoals } }, provenance: { source: r.source } }));
const matches = historyRowsToMatches(rows);
const params = args.params === "trainA" ? RATINGS_V1_PARAMS_TRAIN_A : args.params === "legacy" ? RATINGS_V1_0_PARAMS_LEGACY : RATINGS_V1_PARAMS;
const lagHours = Number(args.lag ?? 12), from = args.from ?? "0000";
const nameOf = new Map(rows.map(r => [`${r.competition.code}|${new Date(r.playedAt).toISOString().slice(0, 16)}`, r])); // only for display names
const predictions = runChronological(matches, { lagHours, params }).filter(p => p.kickoff >= from);
const byId = new Map(matches.map(m => [m.id, m]));
fs.writeFileSync(args.out, predictions.map(p => { const m = byId.get(p.id); return JSON.stringify({ id: p.id, kickoff: p.kickoff, league: p.league, homeId: m.homeId, awayId: m.awayId, hg: m.hg, ag: m.ag, probability: p.probability, heads: p.heads, lambda: p.lambda, depth: p.depth, flags: p.flags, paramsId: p.paramsId, stateHash: p.stateHash, appliedMatches: p.appliedMatches }); }).join("\n") + "\n");
console.log(JSON.stringify({ matches: matches.length, predictions: predictions.length, lagHours, paramsId: paramsId(params), out: args.out }));
