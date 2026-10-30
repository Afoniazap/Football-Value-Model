// Offline hyper-parameter search for ratings-v1 on a TRAINING window only (read-only DB copy). Prints the chosen parameters.
//   node scripts/ratings-v1-tune.js --db <football.sqlite> --train-from 2025-08-01 --train-to 2026-08-01 [--score-from 2025-10-01]
// Nothing after --train-to is read for tuning. `carry` is NOT tuned: with one season of data it is not identifiable for most
// leagues, so it is fixed a priori (0.8) and reported as a sensitivity instead.
import { DatabaseSync } from "node:sqlite";
import { historyRowsToMatches } from "../src/shadow/ratings/ratingsShadow.js";
import { runChronological } from "../src/shadow/ratings/ratingsCore.js";
import { RATINGS_V1_PARAMS } from "../src/shadow/ratings/ratingsParams.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const trainFrom = args["train-from"] ?? "2025-08-01", trainTo = args["train-to"], scoreFrom = args["score-from"] ?? "2025-10-01", lagHours = Number(args.lag ?? 12), CARRY = 0.8;
if (!args.db || !trainTo) { console.error("usage: --db <sqlite> --train-to YYYY-MM-DD [--train-from ..] [--score-from ..]"); process.exit(2); }
const LEAGUES = new Set(["PL", "PD", "SA", "BL1", "FL1", "DED", "PPL", "ELC", "BSA"]);
const db = new DatabaseSync(args.db, { readOnly: true });
const rows = db.prepare("SELECT kickoff playedAt, status, competitionCode, competition, homeTeam, awayTeam, homeGoals, awayGoals, source FROM matches WHERE status IN ('FT','AET','PEN','FINISHED') AND competitionCode IS NOT NULL AND kickoff >= ? AND kickoff < ? ORDER BY kickoff").all(trainFrom, trainTo)
  .filter(r => LEAGUES.has(r.competitionCode)).map(r => ({ playedAt: r.playedAt, status: r.status, competition: { code: r.competitionCode, name: r.competition }, homeTeam: { name: r.homeTeam }, awayTeam: { name: r.awayTeam }, score: { fullTime: { home: r.homeGoals, away: r.awayGoals } }, provenance: { source: r.source } }));
const matches = historyRowsToMatches(rows), byId = new Map(matches.map(m => [m.id, m]));
const logloss = (pred, head) => { let s = 0, n = 0; for (const p of pred) { if (p.kickoff < scoreFrom || Math.min(p.depth.homeGames, p.depth.awayGames) < 3) continue; const m = byId.get(p.id), pr = head(p); s += -Math.log(Math.max(1e-12, m.hg > m.ag ? pr.home : m.hg < m.ag ? pr.away : pr.draw)); n++; } return { ll: s / n, n }; };
const withParams = (poisson, elo) => Object.freeze({ ...RATINGS_V1_PARAMS, poisson: Object.freeze({ ...RATINGS_V1_PARAMS.poisson, carry: CARRY, ...poisson }), elo: Object.freeze({ ...RATINGS_V1_PARAMS.elo, carry: CARRY, ...elo }) });
let bestP = null;
for (const eta of [0.02, 0.035, 0.05, 0.08]) for (const reg of [0.001, 0.004]) for (const warm of [0, 2]) for (const rho of [-0.15, -0.1, -0.05, 0]) {
  const r = logloss(runChronological(matches, { lagHours, params: withParams({ eta, reg, warm, rho }, {}) }), p => p.heads.poissonDc);
  if (!bestP || r.ll < bestP.ll) bestP = { ...r, eta, reg, warm, rho };
}
let bestE = null;
for (const K of [10, 20, 30]) for (const homeAdvantage of [50, 70, 90]) for (const drawWidth of [0.25, 0.4, 0.55]) for (const scale of [250, 400]) {
  const r = logloss(runChronological(matches, { lagHours, params: withParams({}, { K, homeAdvantage, drawWidth, scale }) }), p => p.heads.elo);
  if (!bestE || r.ll < bestE.ll) bestE = { ...r, K, homeAdvantage, drawWidth, scale };
}
const final = withParams({ eta: bestP.eta, reg: bestP.reg, warm: bestP.warm, rho: bestP.rho }, { K: bestE.K, homeAdvantage: bestE.homeAdvantage, drawWidth: bestE.drawWidth, scale: bestE.scale });
const mix = logloss(runChronological(matches, { lagHours, params: final }), p => p.probability);
console.log(JSON.stringify({ trainWindow: [trainFrom, trainTo], scoredFrom: scoreFrom, lagHours, carryFixedAPriori: CARRY, poissonHead: bestP, eloHead: bestE, mixtureTrainingLogLoss: +mix.ll.toFixed(4), scoredMatches: mix.n, params: { poisson: final.poisson, elo: final.elo } }, null, 1));
