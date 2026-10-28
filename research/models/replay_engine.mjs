// Research only. Replays the REAL Termux model code (termux-v0.5 e7e133c) chronologically over the stored match history.
// For every league match: context = season-to-date tables + last 300 league matches BEFORE kickoff (what football-data gives the live system).
// usage: node replay_engine.mjs <termuxSrcRoot> <sqliteFile> <out.json>
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const [ROOT, DBF, OUT] = process.argv.slice(2);
const { teamStrengthModel, formModel, consensus } = await import(`${ROOT}/src/engine/models.js`);
const { buildChallenger } = await import(`${ROOT}/src/shadow/challenger.js`);
const { buildBaselineV2H } = await import(`${ROOT}/src/shadow/baselineV2H.js`);
const { canonicalTeamIdentity } = await import(`${ROOT}/src/history/teamAliases.js`);
const LEAGUES = new Set(["PL","PD","SA","BL1","FL1","DED","PPL","ELC","BSA"]);
const db = new DatabaseSync(DBF, { readOnly: true });
const raw = db.prepare("SELECT competitionCode code, kickoff, homeTeam, awayTeam, homeGoals hg, awayGoals ag, source FROM matches WHERE status IN ('FT','AET','PEN','FINISHED') AND competitionCode IS NOT NULL ORDER BY kickoff").all().filter(r => LEAGUES.has(r.code));
// de-duplicate the same match stored under two spellings (same league, same calendar day, same identity pair); prefer FOOTBALL_DATA
const seen = new Map();
for (const r of raw) {
  const h = canonicalTeamIdentity(r.homeTeam), a = canonicalTeamIdentity(r.awayTeam), key = `${r.code}|${r.kickoff.slice(0,10)}|${h}|${a}`;
  const prev = seen.get(key);
  if (!prev || (r.source === "FOOTBALL_DATA" && prev.source !== "FOOTBALL_DATA")) seen.set(key, { ...r, h, a });
}
const matches = [...seen.values()].sort((x, y) => x.kickoff.localeCompare(y.kickoff));
const seasonOf = r => r.code === "BSA" ? r.kickoff.slice(0, 4) : (r.kickoff.slice(5, 7) >= "07" ? r.kickoff.slice(0, 4) : String(Number(r.kickoff.slice(0, 4)) - 1));
const byLeague = new Map();
for (const m of matches) { m.season = seasonOf(m); (byLeague.get(m.code) || byLeague.set(m.code, []).get(m.code)).push(m); }
function table(rows, mode) {
  const t = new Map();
  const get = id => t.get(id) || t.set(id, { team: { id }, playedGames: 0, points: 0, goalsFor: 0, goalsAgainst: 0 }).get(id);
  for (const m of rows) {
    if (mode !== "AWAY") { const x = get(m.h); x.playedGames++; x.goalsFor += m.hg; x.goalsAgainst += m.ag; x.points += m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0; }
    if (mode !== "HOME") { const x = get(m.a); x.playedGames++; x.goalsFor += m.ag; x.goalsAgainst += m.hg; x.points += m.ag > m.hg ? 3 : m.ag === m.hg ? 1 : 0; }
  }
  return [...t.values()].map(x => ({ ...x, goalDifference: x.goalsFor - x.goalsAgainst }));
}
const asEngineMatch = m => ({ id: `${m.code}${m.kickoff}${m.h}`, utcDate: m.kickoff, homeTeam: { id: m.h, name: m.homeTeam }, awayTeam: { id: m.a, name: m.awayTeam }, score: { fullTime: { home: m.hg, away: m.ag } } });
const out = [];
for (const [code, list] of byLeague) {
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const prior = list.slice(0, i).filter(x => x.kickoff < m.kickoff);   // strictly before kickoff
    const cur = prior.filter(x => x.season === m.season);
    const pHome = cur.filter(x => x.h === m.h).length + cur.filter(x => x.a === m.h).length;
    const pAway = cur.filter(x => x.h === m.a).length + cur.filter(x => x.a === m.a).length;
    if (pHome < 4 || pAway < 4) continue;          // same entry bar as the live model (>=4 games for Form)
    const ctx = { standings: { standings: [{ type: "TOTAL", table: table(cur, "TOTAL") }, { type: "HOME", table: table(cur, "HOME") }, { type: "AWAY", table: table(cur, "AWAY") }] }, finished: prior.slice(-300).map(asEngineMatch) };
    const fx = { homeId: m.h, awayId: m.a, home: m.homeTeam, away: m.awayTeam, utcDate: m.kickoff };
    const ts = teamStrengthModel(fx, ctx), fm = formModel(fx, ctx), cons = consensus([ts, fm]);
    if (!ts || !cons) continue;
    let ch = null, v2 = null;
    try { ch = buildChallenger(fx, ctx); } catch {} try { v2 = buildBaselineV2H(fx, ctx); } catch {}
    const lg = cur.length ? [cur.reduce((s, x) => s + x.hg, 0) / cur.length, cur.reduce((s, x) => s + x.ag, 0) / cur.length] : [null, null];
    out.push({ code, kick: m.kickoff, season: m.season, home: m.homeTeam, away: m.awayTeam, hg: m.hg, ag: m.ag, gHome: pHome, gAway: pAway,
      ts: ts.probability, lam: ts.lambdas, form: fm ? fm.probability : null, cons: cons.probability, nModels: cons.modelsAvailable, agree: cons.agreement,
      ch, v2h: v2, leagueSeasonAvg: lg });
  }
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log("replayed", out.length, "of", matches.length, "league matches");
