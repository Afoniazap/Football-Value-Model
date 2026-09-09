import { removeMarginThreeWay, removeMarginTwoWay, clamp } from "./utils.js";
import { computeBenchmark } from "../connectors/odds.js";

function probabilityFromMatrix(matrix, predicate) {
  return matrix.filter(predicate).reduce((s,x)=>s+x.p,0);
}

export function asianSettlementOutcome(homeGoals, awayGoals, side, rawLine) {
  // `diff + l` below is a numeric add — if a provider ever supplies line as a
  // string, `+` would silently string-concatenate instead of adding
  // (confirmed: line="1" turned a genuine PUSH into a LOSE). Normalize once,
  // up front, the same way totalsSettlementOutcome's subtraction already
  // does implicitly.
  const line = Number(rawLine);
  const legs = Number.isInteger(line*2) ? [line] : [Math.floor(line*2)/2, Math.ceil(line*2)/2];
  const settleLeg = l => {
    const diff = side === "home" ? homeGoals-awayGoals : awayGoals-homeGoals;
    const result = diff + l;
    if (result > 0) return 1;
    if (result === 0) return 0;
    return -1;
  };
  const result=legs.map(settleLeg).reduce((sum,value)=>sum+value,0)/legs.length;
  return result===1?"WIN":result===.5?"HALF_WIN":result===0?"PUSH":result===-.5?"HALF_LOSS":"LOSE";
}

export function asianSettlement(matrix, side, line) {
  const settlement={win:0,halfWin:0,push:0,halfLoss:0,lose:0};
  for (const score of matrix) {
    const outcome=asianSettlementOutcome(score.h,score.a,side,line);
    settlement[{WIN:"win",HALF_WIN:"halfWin",PUSH:"push",HALF_LOSS:"halfLoss",LOSE:"lose"}[outcome]]+=score.p;
  }
  return settlement;
}

export function totalsSettlementOutcome(totalGoals, side, line) {
  const legs = Number.isInteger(line*2) ? [line] : [Math.floor(line*2)/2, Math.ceil(line*2)/2];
  const settleLeg = l => {
    const result = side === "over" ? totalGoals-l : l-totalGoals;
    if (result > 0) return 1;
    if (result === 0) return 0;
    return -1;
  };
  const result=legs.map(settleLeg).reduce((sum,value)=>sum+value,0)/legs.length;
  return result===1?"WIN":result===.5?"HALF_WIN":result===0?"PUSH":result===-.5?"HALF_LOSS":"LOSE";
}

export function totalsSettlement(matrix, side, line) {
  const settlement={win:0,halfWin:0,push:0,halfLoss:0,lose:0};
  for (const score of matrix) {
    const outcome=totalsSettlementOutcome(score.h+score.a,side,line);
    settlement[{WIN:"win",HALF_WIN:"halfWin",PUSH:"push",HALF_LOSS:"halfLoss",LOSE:"lose"}[outcome]]+=score.p;
  }
  return settlement;
}

function evaluateTwoWay(label, probability, odds, marketFair, meta={}) {
  const edge = (probability-marketFair)*100;
  const ev = (probability*odds-1)*100;
  return {
    label, probability, odds, fairOdds:1/probability,
    marketFair, edge, ev, ...meta
  };
}

// A line can only be priced as a plain binary (evaluateTwoWay, above) when a
// push is structurally impossible: half lines (n.5). Every OTHER line —
// integer (n.0, e.g. OU2.0/AH0) as well as quarter (n.25/n.75) — carries real
// win/halfWin/push/halfLoss/lose mechanics and must go through
// evaluateSettlementMarket instead. Integer lines were previously priced with
// evaluateTwoWay's strict P(over)/P(under) and a naive 1/probability fair
// price, which ignores push probability entirely and systematically misprices
// the fair odds (see markets.js audit, section 10 of the OU/Asian totals task).
// Number.isInteger does NOT coerce strings (Number.isInteger("2")===false)
// while arithmetic on the same value does (`"2"*2`===4) — a provider that
// ever supplies a quoted numeric point ("2" instead of 2) would silently
// misclassify a real integer (push-capable) line as a half line under a
// naive `Number.isInteger(line*2)` check. Normalize to a real Number first.
export function isHalfLine(line){const n=Number(line);return Number.isInteger(n*2)&&!Number.isInteger(n);}

// Handles BOTH integer push lines and quarter lines with a single formula:
// asianSettlementOutcome/totalsSettlementOutcome already average one leg
// (integer: win/push/lose only) or two legs (quarter: win/halfWin/push=0/
// halfLoss/lose) — win+halfWin*.5 / lose+halfLoss*.5 reduces to the exact
// section-10 push-aware fair-odds formula for integer lines, and to the
// already-audited stake-weighted formula for quarter lines.
//
// `probability` is the LITERAL full-win probability (settlement.win) — the
// same meaning `probability` already has for 1X2 and half-line markets, so
// nothing that reads `.probability` (Telegram "Model %", ranking, etc.) has
// to know a market is settlement-based to interpret it correctly. It is NOT
// what Edge is computed from, though: a literal "chance of a clean win"
// (concept A, section 6) is not the same concept as a de-vigged two-way
// market price (concept D), so subtracting one from the other would repeat
// the exact mismatch this audit found for integer lines. Edge instead uses
// `breakEvenProbability` (1/fairOdds) — proven, by symmetry, to be the same
// concept D quantity the market side represents: this settlement's
// win/halfWin/push/halfLoss/lose is the exact mirror of the opposite side's
// lose/halfLoss/push/halfWin/win, so both sides' break-even-equivalent
// probabilities always sum to exactly 1, the same structural property a
// de-vigged two-way market price has.
function evaluateSettlementMarket(label,settlement,odds,marketFair,meta={}){
  const winStake=settlement.win+settlement.halfWin*.5;
  const lossStake=settlement.lose+settlement.halfLoss*.5;
  const stakeAtRisk=winStake+lossStake;
  const breakEvenProbability=stakeAtRisk>0?winStake/stakeAtRisk:null;
  const fairOdds=winStake>0?1+lossStake/winStake:Infinity;
  const ev=(settlement.win*(odds-1)+settlement.halfWin*(odds-1)/2-settlement.halfLoss*.5-settlement.lose)*100;
  const probabilityEdge=Number.isFinite(breakEvenProbability)&&Number.isFinite(marketFair)?(breakEvenProbability-marketFair)*100:null;
  return {
    label,odds,marketFair,
    probability:settlement.win,
    fullWinProbability:settlement.win,halfWinProbability:settlement.halfWin,
    pushProbability:settlement.push,halfLossProbability:settlement.halfLoss,
    fullLossProbability:settlement.lose,
    breakEvenProbability,fairOdds,edge:probabilityEdge,probabilityEdge,ev,
    oddsSemantics:"SETTLEMENT_DISTRIBUTION",
    ...meta
  };
}

export function evaluateMarkets(fixture, teamStrength, consensus, oddsData) {
  if (!teamStrength?.scoreMatrix || !oddsData) return [];
  const matrix = teamStrength.scoreMatrix;
  const results = [];
  const p = consensus.probability;
  const benchmark=oddsData.benchmark||computeBenchmark(oddsData.bookmakers||[],fixture.home,fixture.away);

  const h2h = oddsData.best.h2h;
  const h2hBenchmark=benchmark.h2h;
  if (h2h.home && h2h.draw && h2h.away && h2hBenchmark) {
    const fair = removeMarginThreeWay(h2hBenchmark.home,h2hBenchmark.draw,h2hBenchmark.away);
    const meta=(best,benchmarkOdds)=>({market:"1X2",bookmaker:best.bookmaker,bestBookmaker:best.bookmaker,bestOdds:best.odds,benchmarkBookmaker:h2hBenchmark.bookmaker,benchmarkOdds,benchmarkMarketOdds:{home:h2hBenchmark.home,draw:h2hBenchmark.draw,away:h2hBenchmark.away},benchmarkOverround:h2hBenchmark.overround});
    results.push(evaluateTwoWay("П1",p.home,h2h.home.odds,fair.home,meta(h2h.home,h2hBenchmark.home)));
    results.push(evaluateTwoWay("X",p.draw,h2h.draw.odds,fair.draw,meta(h2h.draw,h2hBenchmark.draw)));
    results.push(evaluateTwoWay("П2",p.away,h2h.away.odds,fair.away,meta(h2h.away,h2hBenchmark.away)));
  }
  if (h2h.home && h2h.draw && h2h.away) {
    const dnbHomeProb = p.home/(p.home+p.away);
    const dnbAwayProb = p.away/(p.home+p.away);
    // DNB fair odds shown even when bookmaker DNB is unavailable.
    results.push({label:"П1 DNB",market:"DNB",probability:dnbHomeProb,fairOdds:1/dnbHomeProb,odds:null,edge:null,ev:null,status:"WAIT_ODDS"});
    results.push({label:"П2 DNB",market:"DNB",probability:dnbAwayProb,fairOdds:1/dnbAwayProb,odds:null,edge:null,ev:null,status:"WAIT_ODDS"});
  }

  const totals = oddsData.best.totals;
  const points = [...new Set(Object.values(totals).map(x=>x.point))];
  for (const line of points) {
    const over = totals[`Over|${line}`], under = totals[`Under|${line}`];
    const lineBenchmark=benchmark.totals[line];
    if (!over || !under || !lineBenchmark) continue;
    const [fairOver,fairUnder] = removeMarginTwoWay(lineBenchmark.over,lineBenchmark.under);
    const shared={market:"OU",line,benchmarkBookmaker:lineBenchmark.bookmaker,benchmarkMarketOdds:{over:lineBenchmark.over,under:lineBenchmark.under},benchmarkOverround:lineBenchmark.overround};
    const overMeta={...shared,bookmaker:over.bookmaker,bestBookmaker:over.bookmaker,bestOdds:over.odds,benchmarkOdds:lineBenchmark.over};
    const underMeta={...shared,bookmaker:under.bookmaker,bestBookmaker:under.bookmaker,bestOdds:under.odds,benchmarkOdds:lineBenchmark.under};
    if (isHalfLine(line)) {
      // No push is possible on a half line, so a plain P(over)/P(under) split is exact.
      const pOver = probabilityFromMatrix(matrix,x=>x.h+x.a>line);
      const pUnder = probabilityFromMatrix(matrix,x=>x.h+x.a<line);
      results.push(evaluateTwoWay(`ТБ ${line}`,pOver,over.odds,fairOver,overMeta));
      results.push(evaluateTwoWay(`ТМ ${line}`,pUnder,under.odds,fairUnder,underMeta));
    } else {
      // Integer lines (real push mass) and quarter lines (half-win/half-loss)
      // both need the full settlement distribution, not a binary split.
      const overSettlement=totalsSettlement(matrix,"over",line);
      const underSettlement=totalsSettlement(matrix,"under",line);
      results.push(evaluateSettlementMarket(`ТБ ${line}`,overSettlement,over.odds,fairOver,{...overMeta,settlement:overSettlement}));
      results.push(evaluateSettlementMarket(`ТМ ${line}`,underSettlement,under.odds,fairUnder,{...underMeta,settlement:underSettlement}));
    }
  }

  const spreads = oddsData.best.spreads;
  const entries = Object.values(spreads);
  for (const item of entries) {
    const side = item.name === fixture.home ? "home" : item.name === fixture.away ? "away" : null;
    if (!side) continue;
    const oppositeName = side === "home" ? fixture.away : fixture.home;
    const opposite = spreads[`${oppositeName}|${-item.point}`];
    const lineBenchmark=benchmark.spreads[side==="home"?item.point:-item.point];
    if (!opposite || !lineBenchmark) continue;
    const benchmarkOdds=side==="home"?[lineBenchmark.home,lineBenchmark.away]:[lineBenchmark.away,lineBenchmark.home];
    const [fairThis] = removeMarginTwoWay(...benchmarkOdds);
    const settlement = asianSettlement(matrix,side,item.point);
    const effectiveProbability = settlement.win + settlement.push*0.5;
    const label=`${side==="home"?"Ф1":"Ф2"}(${item.point>0?"+":""}${item.point})`;
    const meta={market:"AH",bookmaker:item.bookmaker,bestBookmaker:item.bookmaker,bestOdds:item.odds,line:item.point,settlement,benchmarkBookmaker:lineBenchmark.bookmaker,benchmarkOdds:benchmarkOdds[0],benchmarkMarketOdds:{selection:benchmarkOdds[0],opposite:benchmarkOdds[1]},benchmarkOverround:lineBenchmark.overround};
    // Same push-aware routing as totals, above: only a genuine half line
    // (±n.5) can never push, so only there is a plain binary split exact.
    results.push(isHalfLine(item.point)
      ? evaluateTwoWay(label,effectiveProbability,item.odds,fairThis,meta)
      : evaluateSettlementMarket(label,settlement,item.odds,fairThis,meta));
  }

  const pBtts = probabilityFromMatrix(matrix,x=>x.h>0 && x.a>0);
  results.push({label:"Обе забьют — Да",market:"BTTS",probability:pBtts,fairOdds:1/pBtts,odds:null,edge:null,ev:null,status:"WAIT_ODDS"});

  return results.sort((a,b)=>(b.edge ?? -999)-(a.edge ?? -999));
}

export function decisionMetrics(candidate, dataQuality, consensusScore, stability, marketAgreement, redFlags=[]) {
  const consensusContribution=Number.isFinite(consensusScore)?consensusScore*0.25:0;
  const stabilityContribution=Number.isFinite(stability)?stability*0.20:0;
  const confidence = Math.round(clamp(
    dataQuality*0.30 + consensusContribution + stabilityContribution +
    (marketAgreement ?? 60)*0.10 + 15 - redFlags.length*6, 0, 100
  ));
  const rawFds = Math.round(clamp(
    Math.max(0,candidate.edge ?? 0)*2.2 +
    Math.max(0,candidate.ev ?? 0)*1.0 +
    confidence*0.30 + dataQuality*0.12 + stability*0.12, 0, 100
  ));

  const fdsCap = Math.min(
    Math.round(clamp(dataQuality + 15, 35, 95)),
    Math.round(clamp(confidence + 10, 35, 98))
  );

  const fds = Math.min(rawFds, fdsCap);

  return {
    confidence,
    fds,
    rawFds,
    fdsCap,
    confidenceParts: {
      dataQuality: Number((dataQuality*0.30).toFixed(1)),
      consensus: Number(consensusContribution.toFixed(1)),
      stability: Number(stabilityContribution.toFixed(1)),
      marketAgreement: Number(((marketAgreement ?? 60)*0.10).toFixed(1)),
      base: 15,
      redFlagPenalty: redFlags.length*6
    },
    fdsParts: {
      edge: Number((Math.max(0,candidate.edge ?? 0)*2.2).toFixed(1)),
      ev: Number((Math.max(0,candidate.ev ?? 0)*1.0).toFixed(1)),
      confidence: Number((confidence*0.30).toFixed(1)),
      dataQuality: Number((dataQuality*0.12).toFixed(1)),
      stability: Number((stability*0.12).toFixed(1))
    }
  };
}
