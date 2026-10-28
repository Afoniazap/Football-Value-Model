// Research only. Isolates the cause of the Team Strength bias by re-running the REAL formModel/consensus with
// controlled variants of teamStrengthModel on the same chronological contexts as replay_engine.mjs.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const [ROOT, DBF, OUT] = process.argv.slice(2);
const { formModel, consensus } = await import(`${ROOT}/src/engine/models.js`);
const { buildScoreMatrix, clamp, safeNumber } = await import(`${ROOT}/src/engine/utils.js`);
const { canonicalTeamIdentity } = await import(`${ROOT}/src/history/teamAliases.js`);
const LEAGUES = new Set(["PL","PD","SA","BL1","FL1","DED","PPL","ELC","BSA"]);
const db = new DatabaseSync(DBF, { readOnly: true });
const raw = db.prepare("SELECT competitionCode code, kickoff, homeTeam, awayTeam, homeGoals hg, awayGoals ag, source FROM matches WHERE status IN ('FT','AET','PEN','FINISHED') AND competitionCode IS NOT NULL ORDER BY kickoff").all().filter(r => LEAGUES.has(r.code));
const seen = new Map();
for (const r of raw) { const h = canonicalTeamIdentity(r.homeTeam), a = canonicalTeamIdentity(r.awayTeam), key = `${r.code}|${r.kickoff.slice(0,10)}|${h}|${a}`; const p = seen.get(key); if (!p || (r.source === "FOOTBALL_DATA" && p.source !== "FOOTBALL_DATA")) seen.set(key, { ...r, h, a }); }
const matches = [...seen.values()].sort((x, y) => x.kickoff.localeCompare(y.kickoff));
const seasonOf = r => r.code === "BSA" ? r.kickoff.slice(0, 4) : (r.kickoff.slice(5, 7) >= "07" ? r.kickoff.slice(0, 4) : String(Number(r.kickoff.slice(0, 4)) - 1));
const byLeague = new Map(); for (const m of matches) { m.season = seasonOf(m); (byLeague.get(m.code) || byLeague.set(m.code, []).get(m.code)).push(m); }
function table(rows, mode) {
  const t = new Map(); const get = id => t.get(id) || t.set(id, { team: { id }, playedGames: 0, points: 0, goalsFor: 0, goalsAgainst: 0 }).get(id);
  for (const m of rows) {
    if (mode !== "AWAY") { const x = get(m.h); x.playedGames++; x.goalsFor += m.hg; x.goalsAgainst += m.ag; x.points += m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0; }
    if (mode !== "HOME") { const x = get(m.a); x.playedGames++; x.goalsFor += m.ag; x.goalsAgainst += m.hg; x.points += m.ag > m.hg ? 3 : m.ag === m.hg ? 1 : 0; }
  } return [...t.values()];
}
const row = (tb, id) => tb.find(x => x.team.id === id) || null;
function ts(fx, ctx, o) {
  const T = ctx.standings.standings.find(s => s.type === "TOTAL").table, Ho = ctx.standings.standings.find(s => s.type === "HOME").table, Aw = ctx.standings.standings.find(s => s.type === "AWAY").table;
  const tH = row(T, fx.homeId), tA = row(T, fx.awayId); if (!tH || !tA) return null;
  const hH = row(Ho, fx.homeId) || tH, aA = row(Aw, fx.awayId) || tA;
  const gH = Math.max(1, hH.playedGames), gA = Math.max(1, aA.playedGames);
  const GF = T.reduce((s, x) => s + x.goalsFor, 0), GP = T.reduce((s, x) => s + x.playedGames, 0), Lall = GP ? GF / GP : 1.35;
  const homeGoals = Ho.reduce((s, x) => s + x.goalsFor, 0), homeGames = Ho.reduce((s, x) => s + x.playedGames, 0);
  const Lh = homeGames ? homeGoals / homeGames : 1.5, La = homeGames ? Ho.reduce((s, x) => s + x.goalsAgainst, 0) / homeGames : 1.2;
  const sh = (rate, g, avg) => o.shrink ? (rate * g + avg * o.shrink) / (g + o.shrink) : rate;
  let lh, la;
  if (o.normalise === "overall") {
    const aAtt = sh(safeNumber(hH.goalsFor) / gH, gH, Lh) / Lall, aDef = sh(safeNumber(aA.goalsAgainst) / gA, gA, Lh) / Lall, bAtt = sh(safeNumber(aA.goalsFor) / gA, gA, La) / Lall, bDef = sh(safeNumber(hH.goalsAgainst) / gH, gH, La) / Lall;
    lh = Lall * aAtt * aDef * o.hf[0]; la = Lall * bAtt * bDef * o.hf[1];
  } else {   // split-normalised: home attack vs league HOME goals, away defence vs league HOME goals (no second home-advantage factor)
    const aAtt = sh(safeNumber(hH.goalsFor) / gH, gH, Lh) / Lh, aDef = sh(safeNumber(aA.goalsAgainst) / gA, gA, Lh) / Lh, bAtt = sh(safeNumber(aA.goalsFor) / gA, gA, La) / La, bDef = sh(safeNumber(hH.goalsAgainst) / gH, gH, La) / La;
    lh = Lh * aAtt * aDef * o.hf[0]; la = La * bAtt * bDef * o.hf[1];
  }
  lh = clamp(lh, 0.25, 3.4); la = clamp(la, 0.2, 3.1);
  const mx = buildScoreMatrix(lh, la), pH = mx.filter(x => x.h > x.a).reduce((s, x) => s + x.p, 0), pD = mx.filter(x => x.h === x.a).reduce((s, x) => s + x.p, 0);
  return { name: "TS", probability: { home: pH, draw: pD, away: 1 - pH - pD }, lambdas: { home: lh, away: la }, quality: Math.round(clamp(55 + Math.min(tH.playedGames, tA.playedGames) * 1.2, 55, 88)) };
}
const VARIANTS = {
  V0_original:                { normalise: "overall", hf: [1.08, 0.92], shrink: 0 },
  V1_no_extra_home_factor:    { normalise: "overall", hf: [1, 1], shrink: 0 },
  V2_split_normalised:        { normalise: "split", hf: [1, 1], shrink: 0 },
  V3_split_normalised_shrink8:{ normalise: "split", hf: [1, 1], shrink: 8 },
  V4_original_plus_shrink8:   { normalise: "overall", hf: [1.08, 0.92], shrink: 8 }
};
const rows = [];
for (const [code, list] of byLeague) for (let i = 0; i < list.length; i++) {
  const m = list[i], prior = list.slice(0, i).filter(x => x.kickoff < m.kickoff), cur = prior.filter(x => x.season === m.season);
  const pH = cur.filter(x => x.h === m.h || x.a === m.h).length, pA = cur.filter(x => x.h === m.a || x.a === m.a).length;
  if (pH < 4 || pA < 4) continue;
  const asE = x => ({ id: x.kickoff + x.h, utcDate: x.kickoff, homeTeam: { id: x.h, name: x.homeTeam }, awayTeam: { id: x.a, name: x.awayTeam }, score: { fullTime: { home: x.hg, away: x.ag } } });
  const ctx = { standings: { standings: [{ type: "TOTAL", table: table(cur, "TOTAL") }, { type: "HOME", table: table(cur, "HOME") }, { type: "AWAY", table: table(cur, "AWAY") }] }, finished: prior.slice(-300).map(asE) };
  const fx = { homeId: m.h, awayId: m.a }, fm = formModel(fx, ctx), rec = { code, kick: m.kickoff, season: m.season, hg: m.hg, ag: m.ag, g: Math.min(pH, pA) };
  for (const [name, o] of Object.entries(VARIANTS)) { const t = ts(fx, ctx, o); if (!t) { rec[name] = null; continue; } const c = consensus([t, fm]); rec[name] = { ts: t.probability, lam: t.lambdas, cons: c.probability }; }
  rows.push(rec);
}
fs.writeFileSync(OUT, JSON.stringify(rows)); console.log("rows", rows.length);
