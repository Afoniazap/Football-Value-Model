// Research only. Runs the (reconstructed) teamStrengthModel(fixture, context, {shrinkageGames:k}) with k in a grid on the same
// chronological contexts as replay_engine.mjs, plus real formModel/consensus/Challenger. Production default must equal k=0.
// usage: node replay_shrinkage_variants.mjs <srcRootWithOptionsParam> <sqlite> <out.json>
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const [ROOT, DBF, OUT] = process.argv.slice(2);
const { teamStrengthModel, formModel, consensus } = await import(`${ROOT}/src/engine/models.js`);
const { buildChallenger } = await import(`${ROOT}/src/shadow/challenger.js`);
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
  } return [...t.values()].map(x => ({ ...x, goalDifference: x.goalsFor - x.goalsAgainst }));
}
const KS = [0, 4, 8, 12, 16];
const rows = [];
for (const [code, list] of byLeague) for (let i = 0; i < list.length; i++) {
  const m = list[i], prior = list.slice(0, i).filter(x => x.kickoff < m.kickoff), cur = prior.filter(x => x.season === m.season);
  const pH = cur.filter(x => x.h === m.h || x.a === m.h).length, pA = cur.filter(x => x.h === m.a || x.a === m.a).length;
  if (pH < 4 || pA < 4) continue;
  const asE = x => ({ id: x.kickoff + x.h, utcDate: x.kickoff, homeTeam: { id: x.h, name: x.homeTeam }, awayTeam: { id: x.a, name: x.awayTeam }, score: { fullTime: { home: x.hg, away: x.ag } } });
  const ctx = { standings: { standings: [{ type: "TOTAL", table: table(cur, "TOTAL") }, { type: "HOME", table: table(cur, "HOME") }, { type: "AWAY", table: table(cur, "AWAY") }] }, finished: prior.slice(-300).map(asE) };
  const fx = { homeId: m.h, awayId: m.a, home: m.homeTeam, away: m.awayTeam, utcDate: m.kickoff }, fm = formModel(fx, ctx);
  const rec = { code, kick: m.kickoff, home: m.homeTeam, away: m.awayTeam, hg: m.hg, ag: m.ag, g: Math.min(pH, pA), default_ts: teamStrengthModel(fx, ctx).probability };
  for (const k of KS) { const t = teamStrengthModel(fx, ctx, { shrinkageGames: k }); const c = consensus([t, fm]); rec[`k${k}`] = { ts: t.probability, lam: t.lambdas, cons: c.probability }; }
  for (const [name, hf] of [["k8_noHF", [1, 1]], ["k0_noHF", [1, 1]], ["k8_HF1.0_0.95", [1.0, 0.95]]]) { const k = name.startsWith("k8") ? 8 : 0; const t = teamStrengthModel(fx, ctx, { shrinkageGames: k, experimentHomeFactors: hf }); const c = consensus([t, fm]); rec[name] = { ts: t.probability, lam: t.lambdas, cons: c.probability }; }
  try { rec.challenger = buildChallenger(fx, ctx); } catch {}
  rows.push(rec);
}
fs.writeFileSync(OUT, JSON.stringify(rows)); console.log("rows", rows.length);
