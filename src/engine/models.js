import { buildScoreMatrix, clamp, safeNumber } from "./utils.js";

function totalTable(context) {
  return context?.standings?.standings?.find(s => s.type === "TOTAL")?.table || [];
}
function homeTable(context) {
  return context?.standings?.standings?.find(s => s.type === "HOME")?.table || [];
}
function awayTable(context) {
  return context?.standings?.standings?.find(s => s.type === "AWAY")?.table || [];
}
function row(table, teamId) {
  return table.find(x => x.team?.id === teamId) || null;
}

function recentMatches(context, teamId, limit = 8) {
  return (context?.finished || [])
    .filter(m => m.homeTeam?.id === teamId || m.awayTeam?.id === teamId)
    .sort((a,b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, limit);
}

function formStats(matches, teamId) {
  let points = 0, gf = 0, ga = 0;
  for (const m of matches) {
    const home = m.homeTeam.id === teamId;
    const s = safeNumber(home ? m.score.fullTime.home : m.score.fullTime.away);
    const c = safeNumber(home ? m.score.fullTime.away : m.score.fullTime.home);
    gf += s; ga += c;
    if (s > c) points += 3; else if (s === c) points += 1;
  }
  return {
    games: matches.length,
    ppg: matches.length ? points / matches.length : null,
    gfpg: matches.length ? gf / matches.length : null,
    gapg: matches.length ? ga / matches.length : null
  };
}

function daysSinceLastMatch(matches) {
  if (!matches.length) return null;
  return (Date.now() - new Date(matches[0].utcDate).getTime()) / 86400000;
}

export function classifyMatch(fixture, context) {
  const h = row(totalTable(context), fixture.homeId);
  const a = row(totalTable(context), fixture.awayId);
  if (!h || !a) return "insufficient-data";
  const rankGap = Math.abs((h.position || 10) - (a.position || 10));
  if (rankGap >= 10) return "favourite-vs-underdog";
  if (rankGap <= 3) return "balanced";
  return "standard";
}

export function teamStrengthModel(fixture, context) {
  const totalH = row(totalTable(context), fixture.homeId);
  const totalA = row(totalTable(context), fixture.awayId);
  const homeH = row(homeTable(context), fixture.homeId) || totalH;
  const awayA = row(awayTable(context), fixture.awayId) || totalA;
  if (!totalH || !totalA) return null;

  const gamesH = Math.max(1, totalH.playedGames);
  const gamesA = Math.max(1, totalA.playedGames);
  const homeGames = Math.max(1, homeH.playedGames || gamesH);
  const awayGames = Math.max(1, awayA.playedGames || gamesA);

  const leagueRows = totalTable(context);
  const leagueGF = leagueRows.reduce((s,x)=>s+safeNumber(x.goalsFor),0);
  const leagueGames = leagueRows.reduce((s,x)=>s+safeNumber(x.playedGames),0);
  const leagueGoalsPerTeam = leagueGames ? leagueGF / leagueGames : 1.35;

  const homeAttack = (safeNumber(homeH.goalsFor) / homeGames) / leagueGoalsPerTeam;
  const homeDefence = (safeNumber(homeH.goalsAgainst) / homeGames) / leagueGoalsPerTeam;
  const awayAttack = (safeNumber(awayA.goalsFor) / awayGames) / leagueGoalsPerTeam;
  const awayDefence = (safeNumber(awayA.goalsAgainst) / awayGames) / leagueGoalsPerTeam;

  const lambdaHome = clamp(leagueGoalsPerTeam * homeAttack * awayDefence * 1.08, 0.25, 3.4);
  const lambdaAway = clamp(leagueGoalsPerTeam * awayAttack * homeDefence * 0.92, 0.20, 3.1);

  const matrix = buildScoreMatrix(lambdaHome, lambdaAway);
  const pHome = matrix.filter(x=>x.h>x.a).reduce((s,x)=>s+x.p,0);
  const pDraw = matrix.filter(x=>x.h===x.a).reduce((s,x)=>s+x.p,0);
  const pAway = 1 - pHome - pDraw;

  return {
    name: "Team Strength",
    probability: { home:pHome, draw:pDraw, away:pAway },
    lambdas: { home:lambdaHome, away:lambdaAway },
    scoreMatrix: matrix,
    quality: Math.round(clamp(55 + Math.min(gamesH,gamesA)*1.2, 55, 88)),
    explanation: `Дом/выезд, голы и таблица: λ ${lambdaHome.toFixed(2)}–${lambdaAway.toFixed(2)}`
  };
}

export function formModel(fixture, context) {
  const hm = recentMatches(context, fixture.homeId, 8);
  const am = recentMatches(context, fixture.awayId, 8);
  if (hm.length < 4 || am.length < 4) return null;
  const h = formStats(hm, fixture.homeId);
  const a = formStats(am, fixture.awayId);

  const strength = clamp((h.ppg-a.ppg)*0.45 + ((h.gfpg-h.gapg)-(a.gfpg-a.gapg))*0.18, -1.5, 1.5);
  const expH = Math.exp(0.25 + strength);
  const expD = Math.exp(0.1 - Math.abs(strength)*0.25);
  const expA = Math.exp(-strength);
  const sum = expH+expD+expA;

  return {
    name: "Opponent-adjusted Form proxy",
    probability: { home:expH/sum, draw:expD/sum, away:expA/sum },
    quality: 66,
    explanation: `Последние 8: PPG ${h.ppg.toFixed(2)}–${a.ppg.toFixed(2)}`
  };
}

export function scheduleCongestion(fixture, context) {
  const hm = recentMatches(context, fixture.homeId, 5);
  const am = recentMatches(context, fixture.awayId, 5);
  const restH = daysSinceLastMatch(hm);
  const restA = daysSinceLastMatch(am);
  if (restH === null || restA === null) return { score:50, differential:0, known:false };

  const load = days => clamp(100 - days*15, 5, 95);
  const sciH = load(restH);
  const sciA = load(restA);
  return {
    score: Math.round((sciH+sciA)/2),
    home: Math.round(sciH),
    away: Math.round(sciA),
    differential: sciH-sciA,
    known:true,
    restDays: {home:restH, away:restA}
  };
}

export function consensus(models) {
  const valid = models.filter(Boolean);
  if (!valid.length) return null;
  const weights = valid.map(m => m.quality || 60);
  const sumW = weights.reduce((a,b)=>a+b,0);
  const p = {home:0,draw:0,away:0};
  valid.forEach((m,i)=>{
    for (const key of Object.keys(p)) p[key] += m.probability[key]*weights[i]/sumW;
  });
  const ranges = ["home","draw","away"].map(key => {
    const values = valid.map(m=>m.probability[key]);
    return Math.max(...values)-Math.min(...values);
  });
  const agreement = valid.length < 2 ? null : Math.round(clamp(100 - Math.max(...ranges)*260, 0, 100));
  return { probability:p, agreement, modelCoverage:valid.length/2, modelsAvailable:valid.length, models:valid };
}
