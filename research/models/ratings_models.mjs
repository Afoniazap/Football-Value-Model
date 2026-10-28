// Research only. Chronological (online, no look-ahead) rating models built from stored results.
// Hyper-parameters are chosen by log-loss on a TRAINING segment only and then frozen for the test segment.
// usage: node ratings_models.mjs <termuxSrcRoot> <sqliteFile> <dual-shadow.jsonl> <out.json>
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const [ROOT, DBF, DUAL, OUT] = process.argv.slice(2);
const { canonicalTeamIdentity } = await import(`${ROOT}/src/history/teamAliases.js`);
const LEAGUES = new Set(["PL","PD","SA","BL1","FL1","DED","PPL","ELC","BSA"]);
const db = new DatabaseSync(DBF, { readOnly: true });
const all = db.prepare("SELECT competitionCode code, kickoff, homeTeam, awayTeam, homeGoals hg, awayGoals ag, source FROM matches WHERE status IN ('FT','AET','PEN','FINISHED') ORDER BY kickoff").all();
const dedupe = rows => { const m = new Map(); for (const r of rows) { const h = canonicalTeamIdentity(r.homeTeam), a = canonicalTeamIdentity(r.awayTeam), k = `${r.code || "-"}|${r.kickoff.slice(0,10)}|${h}|${a}`; const p = m.get(k); if (!p || (r.source === "FOOTBALL_DATA" && p.source !== "FOOTBALL_DATA")) m.set(k, { ...r, h, a }); } return [...m.values()].sort((x, y) => x.kickoff.localeCompare(y.kickoff)); };
const everything = dedupe(all);                                   // all competitions (for rest days)
const league = everything.filter(r => LEAGUES.has(r.code));
const seasonOf = r => r.code === "BSA" ? r.kickoff.slice(0, 4) : (r.kickoff.slice(5, 7) >= "07" ? r.kickoff.slice(0, 4) : String(Number(r.kickoff.slice(0, 4)) - 1));
for (const r of league) r.season = seasonOf(r);
// ---- rest days (days since the team's previous match in ANY stored competition)
const last = new Map(); const rest = new Map();
for (const r of everything) {
  for (const [side, id] of [["h", r.h], ["a", r.a]]) { const prev = last.get(id); rest.set(`${r.kickoff}|${r.h}|${r.a}|${side}`, prev ? (new Date(r.kickoff) - new Date(prev)) / 864e5 : null); last.set(id, r.kickoff); }
}
// ---- score distribution
const fact = [1]; for (let i = 1; i <= 12; i++) fact[i] = fact[i - 1] * i;
const pois = (k, l) => Math.exp(-l) * l ** k / fact[k];
function probs(lh, la, rho = 0, drawBoost = 0) {
  let H = 0, D = 0, A = 0, tot = 0;
  for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) {
    let p = pois(x, lh) * pois(y, la);
    if (x === 0 && y === 0) p *= Math.max(0, 1 - lh * la * rho); else if (x === 0 && y === 1) p *= 1 + lh * rho; else if (x === 1 && y === 0) p *= 1 + la * rho; else if (x === 1 && y === 1) p *= 1 - rho;
    if (x === y) p *= 1 + drawBoost;
    tot += p; if (x > y) H += p; else if (x === y) D += p; else A += p;
  }
  return { home: H / tot, draw: D / tot, away: A / tot };
}
// ---- Poisson ratings (online SGD on the Poisson log-likelihood)
function runPoisson(matches, P) {
  const A = new Map(), Dd = new Map(), AH = new Map(), DH = new Map(), mu = new Map(), ha = new Map(), cnt = new Map(), seasonSeen = new Map();
  const out = new Map();
  for (const m of matches) {
    const L = m.code;
    if (!mu.has(L)) { mu.set(L, Math.log(1.3)); ha.set(L, 0.2); }
    const prevSeason = seasonSeen.get(L);
    if (prevSeason !== undefined && prevSeason !== m.season) { for (const map of [A, Dd, AH, DH]) for (const [k, v] of map) map.set(k, v * P.carry); }
    seasonSeen.set(L, m.season);
    const g = (map, id) => map.get(`${L}|${id}`) || 0;
    const aH = g(A, m.h) + (P.split ? g(AH, m.h) : 0), dH = g(Dd, m.h) + (P.split ? g(DH, m.h) : 0);
    const aA = g(A, m.a), dA = g(Dd, m.a);
    const lh = Math.exp(mu.get(L) + ha.get(L) + aH - dA), la = Math.exp(mu.get(L) + aA - dH);
    const nH = cnt.get(`${L}|${m.h}`) || 0, nA = cnt.get(`${L}|${m.a}`) || 0;
    out.set(m, { lh, la, nH, nA, p: probs(lh, la, P.rho, P.drawBoost) });
    const eH = m.hg - lh, eA = m.ag - la, e = P.eta * (1 + P.warm / (1 + Math.min(nH, nA)));   // larger steps for teams with few observations
    const upd = (map, id, dlt) => map.set(`${L}|${id}`, g(map, id) + dlt);
    const reg = P.reg;
    upd(A, m.h, e * eH - reg * g(A, m.h)); upd(Dd, m.a, -e * eH - reg * g(Dd, m.a));
    upd(A, m.a, e * eA - reg * g(A, m.a)); upd(Dd, m.h, -e * eA - reg * g(Dd, m.h));
    if (P.split) { upd(AH, m.h, P.etaSplit * eH - reg * g(AH, m.h)); upd(DH, m.h, -P.etaSplit * eA - reg * g(DH, m.h)); }
    mu.set(L, mu.get(L) + P.etaLeague * ((m.hg + m.ag) / 2 - (lh + la) / 2) / 1.3);
    ha.set(L, ha.get(L) + P.etaLeague * ((m.hg - m.ag) - (lh - la)) / 2.6);
    cnt.set(`${L}|${m.h}`, nH + 1); cnt.set(`${L}|${m.a}`, nA + 1);
  }
  return out;
}
const ll = (p, m) => -Math.log(Math.max(1e-12, p[m.hg > m.ag ? "home" : m.hg < m.ag ? "away" : "draw"]));
const inRange = (m, lo, hi) => m.kickoff >= lo && m.kickoff < hi;
function score(out, lo, hi) { let s = 0, n = 0; for (const [m, v] of out) if (inRange(m, lo, hi) && v.nH >= 3 && v.nA >= 3) { s += ll(v.p, m); n++; } return n ? s / n : Infinity; }
// ---- hyper-parameter search on TRAINING segments only
const BASE = { eta: 0.04, carry: 0.7, reg: 0.002, warm: 1.0, rho: 0, drawBoost: 0, split: false, etaSplit: 0.01, etaLeague: 0.01 };
function tune(lo, hi, extra = {}) {
  let best = null;
  for (const eta of [0.02, 0.035, 0.05, 0.08]) for (const carry of [0.5, 0.7, 0.85]) for (const reg of [0.001, 0.004]) for (const warm of [0, 2]) {
    const P = { ...BASE, ...extra, eta, carry, reg, warm };
    const s = score(runPoisson(league, P), lo, hi);
    if (!best || s < best.s) best = { s, P };
  }
  return best;
}
function tuneRho(P, lo, hi) { let best = null; for (const rho of [-0.15, -0.1, -0.05, 0, 0.05]) for (const drawBoost of [0, 0.05, 0.1]) { const Q = { ...P, rho, drawBoost }; const s = score(runPoisson(league, Q), lo, hi); if (!best || s < best.s) best = { s, P: Q }; } return best; }
const BURN = ["2025-08-01", "2026-01-01"], TESTA = ["2026-01-01", "2026-07-01"], TESTB = ["2026-08-01", "2027-01-01"];
const chosen = {};
// Test A is predicted with parameters tuned on the burn-in half-season only; test B with parameters tuned on everything before 2026-08.
const trainFor = seg => seg === "A" ? BURN : ["2025-08-01", "2026-08-01"];
const variants = { poisson: {}, poisson_dc: { dc: true }, poisson_split: { split: true } };
const result = new Map();   // match -> {variant: probs}
for (const seg of ["A", "B"]) {
  const [tlo, thi] = trainFor(seg), [lo, hi] = seg === "A" ? TESTA : TESTB;
  const t0 = tune(tlo, thi);
  const t1 = tuneRho(t0.P, tlo, thi);
  const t2 = tune(tlo, thi, { split: true });
  chosen[seg] = { poisson: { trainLL: +t0.s.toFixed(4), P: t0.P }, poisson_dc: { trainLL: +t1.s.toFixed(4), P: t1.P }, poisson_split: { trainLL: +t2.s.toFixed(4), P: t2.P } };
  for (const [name, P] of [["poisson", t0.P], ["poisson_dc", t1.P], ["poisson_split", t2.P]]) {
    const o = runPoisson(league, P);
    for (const [m, v] of o) if (inRange(m, lo, hi)) { const rec = result.get(m) || result.set(m, { seg, nH: v.nH, nA: v.nA }).get(m); rec[name] = v.p; rec[name + "_lam"] = [v.lh, v.la]; }
  }
}
// ---- Elo with goal-difference weighting and an ordered-logit draw model
function runElo(matches, K, HA, width, carry, sd) {
  const R = new Map(), seen = new Map(), out = new Map();
  for (const m of matches) {
    const L = m.code, ps = seen.get(L);
    if (ps !== undefined && ps !== m.season) for (const [k, v] of R) if (k.startsWith(L + "|")) R.set(k, 1500 + (v - 1500) * carry);
    seen.set(L, m.season);
    const rh = R.get(`${L}|${m.h}`) ?? 1500, ra = R.get(`${L}|${m.a}`) ?? 1500, x = (rh + HA - ra) / sd;
    const sg = z => 1 / (1 + Math.exp(-z));
    const pH = sg(x - width), pA = sg(-x - width), p = { home: pH, draw: Math.max(1e-6, 1 - pH - pA), away: pA };
    out.set(m, p);
    const E = 1 / (1 + 10 ** ((ra - rh - HA) / 400)), S = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0, gd = Math.abs(m.hg - m.ag), G = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    R.set(`${L}|${m.h}`, rh + K * G * (S - E)); R.set(`${L}|${m.a}`, ra - K * G * (S - E));
  }
  return out;
}
const eloScore = (out, lo, hi) => { let s = 0, n = 0; for (const [m, p] of out) if (inRange(m, lo, hi)) { s += ll(p, m); n++; } return s / n; };
const eloChosen = {};
for (const seg of ["A", "B"]) {
  const [tlo, thi] = trainFor(seg), [lo, hi] = seg === "A" ? TESTA : TESTB;
  let best = null;
  for (const K of [10, 20, 30]) for (const HA of [50, 70, 90]) for (const width of [0.25, 0.4, 0.55]) for (const carry of [0.6, 0.8]) for (const sd of [250, 400]) {
    const o = runElo(league, K, HA, width, carry, sd), s = eloScore(o, tlo, thi); if (!best || s < best.s) best = { s, K, HA, width, carry, sd };
  }
  eloChosen[seg] = best;
  const o = runElo(league, best.K, best.HA, best.width, best.carry, best.sd);
  for (const [m, p] of o) if (inRange(m, lo, hi)) { const rec = result.get(m) || result.set(m, { seg }).get(m); rec.elo = p; }
}
// ---- export
const matchRows = [...result].map(([m, r]) => ({ code: m.code, kick: m.kickoff, h: m.h, a: m.a, home: m.homeTeam, away: m.awayTeam, hg: m.hg, ag: m.ag, season: m.season, seg: r.seg, nH: r.nH, nA: r.nA, rest: [rest.get(`${m.kickoff}|${m.h}|${m.a}|h`), rest.get(`${m.kickoff}|${m.h}|${m.a}|a`)], poisson: r.poisson, poisson_dc: r.poisson_dc, poisson_split: r.poisson_split, lam: r.poisson_lam, elo: r.elo }));
// map the 427 dual-shadow fixtures onto league matches (identity + date +-1 day)
const dual = fs.readFileSync(DUAL, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const key = (d, h, a) => `${d}|${h}|${a}`; const idx = new Map(matchRows.map(r => [key(r.kick.slice(0, 10), r.h, r.a), r]));
let mapped = 0; const dualMap = {};
for (const r of dual.filter(x => x.type === "SHADOW_PREDICTION")) {
  const h = canonicalTeamIdentity(r.home), a = canonicalTeamIdentity(r.away), d0 = new Date(r.kickoff);
  for (const delta of [0, -1, 1]) { const d = new Date(d0.getTime() + delta * 864e5).toISOString().slice(0, 10); const hit = idx.get(key(d, h, a)); if (hit) { dualMap[r.snapshotKey] = `${hit.kick}|${hit.h}|${hit.a}`; mapped++; break; } }
}
fs.writeFileSync(OUT, JSON.stringify({ chosen, eloChosen, matches: matchRows, dualMap }));
console.log("matches", matchRows.length, "dual mapped", mapped, "of", dual.filter(x => x.type === "SHADOW_PREDICTION").length);

// ---- ablations (only with ABLATE=1): what part of the rating model carries the gain? Parameters stay those chosen on TRAINING data.
if (process.env.ABLATE === "1") {
  const rows = {};
  for (const seg of ["A", "B"]) {
    const [lo, hi] = seg === "A" ? TESTA : TESTB, P0 = chosen[seg].poisson.P;
    const variants = {
      tuned: P0, no_previous_season_prior: { ...P0, carry: 0 }, full_carry_over: { ...P0, carry: 1 }, slower_updates: { ...P0, eta: P0.eta / 2 }, faster_updates: { ...P0, eta: P0.eta * 2 },
      no_warmup_for_new_teams: { ...P0, warm: 0 }, stronger_shrinkage: { ...P0, reg: P0.reg * 5 }, separate_home_away_strength: { ...P0, split: true }, no_league_home_advantage_learning: { ...P0, etaLeague: 0 }
    };
    rows[seg] = {};
    for (const [name, P] of Object.entries(variants)) rows[seg][name] = +score(runPoisson(league, P), lo, hi).toFixed(4);
  }
  fs.writeFileSync(OUT.replace(/\.json$/, "_ablation.json"), JSON.stringify(rows, null, 1)); console.log(JSON.stringify(rows));
}
