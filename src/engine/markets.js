import { removeMarginThreeWay, removeMarginTwoWay, clamp } from "./utils.js";

function probabilityFromMatrix(matrix, predicate) {
  return matrix.filter(predicate).reduce((s,x)=>s+x.p,0);
}

export function asianSettlementOutcome(homeGoals, awayGoals, side, line) {
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

function evaluateQuarterSettlement(label,settlement,odds,marketFair,meta={}){
  const winStake=settlement.win+settlement.halfWin*.5;
  const lossStake=settlement.lose+settlement.halfLoss*.5;
  const probability=winStake/(winStake+lossStake);
  const fairOdds=winStake>0?1+lossStake/winStake:Infinity;
  const ev=(settlement.win*(odds-1)+settlement.halfWin*(odds-1)/2-settlement.halfLoss*.5-settlement.lose)*100;
  return {label,probability,odds,fairOdds,marketFair,edge:(probability-marketFair)*100,ev,...meta};
}

export function evaluateMarkets(fixture, teamStrength, consensus, oddsData) {
  if (!teamStrength?.scoreMatrix || !oddsData) return [];
  const matrix = teamStrength.scoreMatrix;
  const results = [];
  const p = consensus.probability;

  const h2h = oddsData.best.h2h;
  if (h2h.home && h2h.draw && h2h.away) {
    const fair = removeMarginThreeWay(h2h.home.odds,h2h.draw.odds,h2h.away.odds);
    results.push(evaluateTwoWay("П1",p.home,h2h.home.odds,fair.home,{market:"1X2",bookmaker:h2h.home.bookmaker}));
    results.push(evaluateTwoWay("X",p.draw,h2h.draw.odds,fair.draw,{market:"1X2",bookmaker:h2h.draw.bookmaker}));
    results.push(evaluateTwoWay("П2",p.away,h2h.away.odds,fair.away,{market:"1X2",bookmaker:h2h.away.bookmaker}));

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
    if (!over || !under) continue;
    const [fairOver,fairUnder] = removeMarginTwoWay(over.odds,under.odds);
    const pOver = probabilityFromMatrix(matrix,x=>x.h+x.a>line);
    const pUnder = probabilityFromMatrix(matrix,x=>x.h+x.a<line);
    const overMeta={market:"OU",bookmaker:over.bookmaker,line};
    const underMeta={market:"OU",bookmaker:under.bookmaker,line};
    if (Number.isInteger(line*2)) {
      results.push(evaluateTwoWay(`ТБ ${line}`,pOver,over.odds,fairOver,overMeta));
      results.push(evaluateTwoWay(`ТМ ${line}`,pUnder,under.odds,fairUnder,underMeta));
    } else {
      const overSettlement=totalsSettlement(matrix,"over",line);
      const underSettlement=totalsSettlement(matrix,"under",line);
      results.push(evaluateQuarterSettlement(`ТБ ${line}`,overSettlement,over.odds,fairOver,{...overMeta,settlement:overSettlement}));
      results.push(evaluateQuarterSettlement(`ТМ ${line}`,underSettlement,under.odds,fairUnder,{...underMeta,settlement:underSettlement}));
    }
  }

  const spreads = oddsData.best.spreads;
  const entries = Object.values(spreads);
  for (const item of entries) {
    const side = item.name === fixture.home ? "home" : item.name === fixture.away ? "away" : null;
    if (!side) continue;
    const oppositeName = side === "home" ? fixture.away : fixture.home;
    const opposite = spreads[`${oppositeName}|${-item.point}`];
    if (!opposite) continue;
    const [fairThis] = removeMarginTwoWay(item.odds,opposite.odds);
    const settlement = asianSettlement(matrix,side,item.point);
    const effectiveProbability = settlement.win + settlement.push*0.5;
    const label=`${side==="home"?"Ф1":"Ф2"}(${item.point>0?"+":""}${item.point})`;
    const meta={market:"AH",bookmaker:item.bookmaker,line:item.point,settlement};
    results.push(Number.isInteger(item.point*2)
      ? evaluateTwoWay(label,effectiveProbability,item.odds,fairThis,meta)
      : evaluateQuarterSettlement(label,settlement,item.odds,fairThis,meta));
  }

  const pBtts = probabilityFromMatrix(matrix,x=>x.h>0 && x.a>0);
  results.push({label:"Обе забьют — Да",market:"BTTS",probability:pBtts,fairOdds:1/pBtts,odds:null,edge:null,ev:null,status:"WAIT_ODDS"});

  return results.sort((a,b)=>(b.edge ?? -999)-(a.edge ?? -999));
}

export function decisionMetrics(candidate, dataQuality, consensusScore, stability, marketAgreement, redFlags=[]) {
  const confidence = Math.round(clamp(
    dataQuality*0.30 + consensusScore*0.25 + stability*0.20 +
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
      consensus: Number((consensusScore*0.25).toFixed(1)),
      stability: Number((stability*0.20).toFixed(1)),
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
