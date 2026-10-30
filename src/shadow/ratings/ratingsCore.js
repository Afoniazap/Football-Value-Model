// ratings-v1: opponent-adjusted team ratings with carry-over between seasons. PURE module: no I/O, no clock, no random,
// no imports from the production engine. Same inputs -> bit-identical outputs.
import { RATINGS_V1_PARAMS, paramsId } from "./ratingsParams.js";

const FACT = [1];
for (let i = 1; i <= 14; i++) FACT[i] = FACT[i - 1] * i;
const poissonPmf = (k, lambda) => Math.exp(-lambda) * lambda ** k / FACT[k];
const sigmoid = z => 1 / (1 + Math.exp(-z));

export function seasonLabel(leagueCode, kickoffIso) {
  const year = Number(String(kickoffIso).slice(0, 4)), month = Number(String(kickoffIso).slice(5, 7));
  if (leagueCode === "BSA") return String(year);                 // calendar-year season
  return String(month >= 7 ? year : year - 1);                    // European season starts in July
}

export function createState(params = RATINGS_V1_PARAMS) {
  return {
    params, paramsId: paramsId(params),
    teams: new Map(),          // `${league}|${team}` -> { a, d, games }
    elo: new Map(),            // `${league}|${team}` -> rating
    leagues: new Map(),        // league -> { mu, ha, season }
    applied: 0, hash: 2166136261, lastKickoff: null
  };
}

const teamKey = (league, id) => `${league}|${id}`;
function league(state, code) {
  if (!state.leagues.has(code)) state.leagues.set(code, { mu: state.params.poisson.initialMu, ha: state.params.poisson.initialHomeAdvantage, season: null });
  return state.leagues.get(code);
}
const teamOf = (state, key) => state.teams.get(key) || { a: 0, d: 0, games: 0 };

function fnv(hash, text) {
  let h = hash >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// ratings seen from a season later than the league's last processed season are shrunk exactly as applyMatch would shrink them
function carryFactors(state, code, season) {
  const lg = state.leagues.get(code);
  return lg && lg.season !== null && lg.season !== season ? { poisson: state.params.poisson.carry, elo: state.params.elo.carry } : { poisson: 1, elo: 1 };
}

function scoreMatrixProbabilities(lh, la, rho, maxGoals) {
  let home = 0, draw = 0, away = 0, total = 0;
  for (let x = 0; x <= maxGoals; x++) for (let y = 0; y <= maxGoals; y++) {
    let p = poissonPmf(x, lh) * poissonPmf(y, la);
    if (x === 0 && y === 0) p *= Math.max(0, 1 - lh * la * rho);
    else if (x === 0 && y === 1) p *= 1 + lh * rho;
    else if (x === 1 && y === 0) p *= 1 + la * rho;
    else if (x === 1 && y === 1) p *= 1 - rho;
    total += p;
    if (x > y) home += p; else if (x === y) draw += p; else away += p;
  }
  return { home: home / total, draw: draw / total, away: away / total };
}

/** Pure prediction; never mutates the state. fixture: { league, season, homeId, awayId } */
export function predict(state, fixture) {
  const P = state.params;
  const lg = state.leagues.get(fixture.league) || { mu: P.poisson.initialMu, ha: P.poisson.initialHomeAdvantage, season: null };
  const carry = carryFactors(state, fixture.league, fixture.season);
  const h = teamOf(state, teamKey(fixture.league, fixture.homeId)), a = teamOf(state, teamKey(fixture.league, fixture.awayId));
  const aH = h.a * carry.poisson, dH = h.d * carry.poisson, aA = a.a * carry.poisson, dA = a.d * carry.poisson;
  const lh = Math.exp(lg.mu + lg.ha + aH - dA), la = Math.exp(lg.mu + aA - dH);
  const poissonHead = scoreMatrixProbabilities(lh, la, P.poisson.rho, P.maxGoals);
  const eloOf = id => 1500 + ((state.elo.get(teamKey(fixture.league, id)) ?? P.elo.initial) - 1500) * carry.elo;
  const x = (eloOf(fixture.homeId) + P.elo.homeAdvantage - eloOf(fixture.awayId)) / P.elo.scale;
  const pH = sigmoid(x - P.elo.drawWidth), pA = sigmoid(-x - P.elo.drawWidth), eloHead = { home: pH, draw: Math.max(1e-6, 1 - pH - pA), away: pA };
  const mix = { home: (poissonHead.home + eloHead.home) / 2, draw: (poissonHead.draw + eloHead.draw) / 2, away: (poissonHead.away + eloHead.away) / 2 };
  const sum = mix.home + mix.draw + mix.away;
  return {
    probability: { home: mix.home / sum, draw: mix.draw / sum, away: mix.away / sum },
    heads: { poissonDc: poissonHead, elo: eloHead },
    lambda: { home: lh, away: la },
    depth: { homeGames: h.games, awayGames: a.games },
    flags: [...(h.games === 0 || a.games === 0 ? ["NEW_TEAM"] : []), ...(Math.min(h.games, a.games) < 8 ? ["LOW_DEPTH"] : [])],
    paramsId: state.paramsId, stateHash: state.hash.toString(16).padStart(8, "0"), appliedMatches: state.applied
  };
}

/** Learns from ONE finished match. Matches must be applied in chronological order (the caller guarantees it; checked here). */
export function applyMatch(state, match) {
  if (!Number.isFinite(match.hg) || !Number.isFinite(match.ag)) throw new Error(`ratings-v1: match ${match.id} has no final score`);
  if (state.lastKickoff !== null && match.kickoff < state.lastKickoff) throw new Error(`ratings-v1: match ${match.id} is older than the last applied match`);
  const P = state.params, lg = league(state, match.league);
  if (lg.season !== null && lg.season !== match.season) {
    for (const [key, t] of state.teams) if (key.startsWith(`${match.league}|`)) state.teams.set(key, { ...t, a: t.a * P.poisson.carry, d: t.d * P.poisson.carry });
    for (const [key, r] of state.elo) if (key.startsWith(`${match.league}|`)) state.elo.set(key, 1500 + (r - 1500) * P.elo.carry);
  }
  lg.season = match.season;
  const hk = teamKey(match.league, match.homeId), ak = teamKey(match.league, match.awayId);
  const h = teamOf(state, hk), a = teamOf(state, ak);
  const lh = Math.exp(lg.mu + lg.ha + h.a - a.d), la = Math.exp(lg.mu + a.a - h.d);
  const step = P.poisson.eta * (1 + P.poisson.warm / (1 + Math.min(h.games, a.games)));
  const eH = match.hg - lh, eA = match.ag - la, reg = P.poisson.reg;
  state.teams.set(hk, { a: h.a + step * eH - reg * h.a, d: h.d - step * eA - reg * h.d, games: h.games + 1 });
  state.teams.set(ak, { a: a.a + step * eA - reg * a.a, d: a.d - step * eH - reg * a.d, games: a.games + 1 });
  lg.mu += P.poisson.etaLeague * ((match.hg + match.ag) / 2 - (lh + la) / 2) / 1.3;
  lg.ha += P.poisson.etaLeague * ((match.hg - match.ag) - (lh - la)) / 2.6;
  // Elo head (goal-difference weighted)
  const rh = state.elo.get(hk) ?? P.elo.initial, ra = state.elo.get(ak) ?? P.elo.initial;
  const expected = 1 / (1 + 10 ** ((ra - rh - P.elo.homeAdvantage) / 400)), score = match.hg > match.ag ? 1 : match.hg === match.ag ? 0.5 : 0;
  const gd = Math.abs(match.hg - match.ag), weight = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
  const delta = P.elo.K * weight * (score - expected);
  state.elo.set(hk, rh + delta); state.elo.set(ak, ra - delta);
  state.applied += 1; state.lastKickoff = match.kickoff; state.hash = fnv(state.hash, String(match.id));
  return state;
}

const RESULT_AVAILABLE_MS = params => params.resultAvailableAfterMinutes * 60_000;
export const resultAvailableAt = (match, params = RATINGS_V1_PARAMS) => new Date(new Date(match.kickoff).getTime() + RESULT_AVAILABLE_MS(params)).toISOString();

/**
 * Chronologically safe batch runner. For every target (a fixture, finished or not) the state contains ONLY matches whose result
 * was available at (target.kickoff - lagHours): resultAvailableAt <= cutoff. Targets are scored before they are learned.
 * matches: [{ id, league, season, kickoff, homeId, awayId, hg, ag }] in any order (sorted internally by kickoff, id).
 */
export function runChronological(matches, { lagHours = 12, params = RATINGS_V1_PARAMS, targets = null } = {}) {
  const ordered = [...matches].sort((x, y) => (x.kickoff < y.kickoff ? -1 : x.kickoff > y.kickoff ? 1 : String(x.id) < String(y.id) ? -1 : 1));
  const state = createState(params), out = [];
  let pointer = 0;
  const wanted = targets ? new Set(targets) : null;
  for (const target of ordered) {
    const cutoff = new Date(new Date(target.kickoff).getTime() - lagHours * 3_600_000).toISOString();
    while (pointer < ordered.length && resultAvailableAt(ordered[pointer], params) <= cutoff && ordered[pointer].kickoff < target.kickoff) applyMatch(state, ordered[pointer++]);
    if (!wanted || wanted.has(target.id)) out.push({ id: target.id, kickoff: target.kickoff, league: target.league, ...predict(state, target) });
  }
  return out;
}

/** State from a finite set of known-final matches as of `cutoffIso` (live use: cutoff = prediction time). */
export function buildStateAsOf(matches, cutoffIso, params = RATINGS_V1_PARAMS) {
  const usable = [...matches].filter(m => resultAvailableAt(m, params) <= cutoffIso).sort((x, y) => (x.kickoff < y.kickoff ? -1 : x.kickoff > y.kickoff ? 1 : String(x.id) < String(y.id) ? -1 : 1));
  const state = createState(params);
  for (const m of usable) applyMatch(state, m);
  return state;
}
