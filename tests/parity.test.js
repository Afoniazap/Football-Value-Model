import assert from "node:assert/strict";
import { buildModel } from "../src/model/probability.js";
import { classify } from "../src/decision/classify.js";
import { findOddsEvent } from "../src/market/oddsMatching.js";

const config = {
  minEdgePercent: 4,
  minDataQuality: 65
};

const fixture = {
  id: "fixture-1",
  competitionCode: "PL",
  competition: "Premier League",
  utcDate: "2026-08-18T18:00:00Z",
  home: "Arsenal FC",
  away: "Chelsea FC",
  homeId: 1,
  awayId: 2,
  matchday: 1
};

const context = {
  standings: {
    standings: [{
      type: "TOTAL",
      table: [
        {
          team: { id: 1 },
          playedGames: 20,
          points: 44,
          goalDifference: 22,
          goalsFor: 44,
          goalsAgainst: 22
        },
        {
          team: { id: 2 },
          playedGames: 20,
          points: 34,
          goalDifference: 8,
          goalsFor: 34,
          goalsAgainst: 26
        }
      ]
    }]
  },
  matches: [
    { utcDate: "2026-08-01T18:00:00Z", homeTeam: { id: 1 }, awayTeam: { id: 3 }, score: { fullTime: { home: 2, away: 0 } } },
    { utcDate: "2026-08-02T18:00:00Z", homeTeam: { id: 4 }, awayTeam: { id: 1 }, score: { fullTime: { home: 1, away: 1 } } },
    { utcDate: "2026-08-03T18:00:00Z", homeTeam: { id: 1 }, awayTeam: { id: 5 }, score: { fullTime: { home: 3, away: 1 } } },
    { utcDate: "2026-08-04T18:00:00Z", homeTeam: { id: 6 }, awayTeam: { id: 1 }, score: { fullTime: { home: 0, away: 1 } } },
    { utcDate: "2026-08-05T18:00:00Z", homeTeam: { id: 1 }, awayTeam: { id: 7 }, score: { fullTime: { home: 2, away: 2 } } },
    { utcDate: "2026-08-01T18:00:00Z", homeTeam: { id: 2 }, awayTeam: { id: 8 }, score: { fullTime: { home: 1, away: 0 } } },
    { utcDate: "2026-08-02T18:00:00Z", homeTeam: { id: 9 }, awayTeam: { id: 2 }, score: { fullTime: { home: 2, away: 1 } } },
    { utcDate: "2026-08-03T18:00:00Z", homeTeam: { id: 2 }, awayTeam: { id: 10 }, score: { fullTime: { home: 0, away: 0 } } },
    { utcDate: "2026-08-04T18:00:00Z", homeTeam: { id: 11 }, awayTeam: { id: 2 }, score: { fullTime: { home: 1, away: 2 } } },
    { utcDate: "2026-08-05T18:00:00Z", homeTeam: { id: 2 }, awayTeam: { id: 12 }, score: { fullTime: { home: 2, away: 2 } } }
  ]
};

const oddsEvent = {
  home_team: "Arsenal FC",
  away_team: "Chelsea FC",
  commence_time: "2026-08-18T18:00:00Z",
  bookmakers: [{
    title: "Book A",
    markets: [{
      key: "h2h",
      outcomes: [
        { name: "Arsenal FC", price: 2.1 },
        { name: "Draw", price: 3.4 },
        { name: "Chelsea FC", price: 3.8 }
      ]
    }]
  }]
};

function oldTeamRow(ctx, teamId) {
  const table = ctx?.standings?.standings?.find(s => s.type === "TOTAL")?.table || [];
  return table.find(row => row.team?.id === teamId);
}

function oldRecentForm(ctx, teamId, limit = 5) {
  const games = (ctx?.matches || [])
    .filter(m => m.homeTeam?.id === teamId || m.awayTeam?.id === teamId)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, limit);

  let points = 0;
  let gf = 0;
  let ga = 0;

  for (const match of games) {
    const isHome = match.homeTeam.id === teamId;
    const scored = Number(isHome ? match.score.fullTime.home : match.score.fullTime.away) || 0;
    const conceded = Number(isHome ? match.score.fullTime.away : match.score.fullTime.home) || 0;
    gf += scored;
    ga += conceded;
    if (scored > conceded) points += 3;
    else if (scored === conceded) points += 1;
  }
  return { games: games.length, points, gf, ga };
}

function oldSoftmax3(home, draw, away) {
  const values = [home, draw, away];
  const max = Math.max(...values);
  const exp = values.map(v => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / sum);
}

function oldBuildModel(inputFixture, ctx) {
  const home = oldTeamRow(ctx, inputFixture.homeId);
  const away = oldTeamRow(ctx, inputFixture.awayId);
  const homeForm = oldRecentForm(ctx, inputFixture.homeId);
  const awayForm = oldRecentForm(ctx, inputFixture.awayId);

  if (!home || !away || homeForm.games < 3 || awayForm.games < 3) {
    return {
      ...inputFixture,
      dataQuality: 48,
      category: "wait",
      reason: "Недостаточно данных таблицы или свежей формы.",
      model: null
    };
  }

  const hp = Math.max(home.playedGames || 1, 1);
  const ap = Math.max(away.playedGames || 1, 1);
  const ppgH = home.points / hp;
  const ppgA = away.points / ap;
  const gdH = home.goalDifference / hp;
  const gdA = away.goalDifference / ap;
  const formH = homeForm.points / (homeForm.games * 3);
  const formA = awayForm.points / (awayForm.games * 3);

  const strength =
    (ppgH - ppgA) * 0.65 +
    (gdH - gdA) * 0.22 +
    (formH - formA) * 0.75;

  const [pHome, pDraw, pAway] = oldSoftmax3(
    0.28 + strength,
    0.05 - Math.abs(strength) * 0.28,
    -strength
  );

  const avgGoalsH = (home.goalsFor + home.goalsAgainst) / hp;
  const avgGoalsA = (away.goalsFor + away.goalsAgainst) / ap;
  const expectedGoals = Math.max(1.4, Math.min(4.0, (avgGoalsH + avgGoalsA) / 2));

  const dataQuality = Math.round(
    Math.min(82, 55 + Math.min(hp, ap) * 0.7 + Math.min(homeForm.games, awayForm.games) * 2)
  );

  return {
    ...inputFixture,
    dataQuality,
    model: {
      home: pHome,
      draw: pDraw,
      away: pAway,
      expectedGoals,
      components: { ppgH, ppgA, gdH, gdA, formH, formA }
    }
  };
}

function oldBestH2H(event) {
  if (!event) return null;
  let best = null;

  for (const book of event.bookmakers || []) {
    const market = book.markets?.find(m => m.key === "h2h");
    if (!market) continue;

    const values = {};
    for (const outcome of market.outcomes || []) values[outcome.name] = outcome.price;

    const row = {
      bookmaker: book.title,
      home: values[event.home_team],
      draw: values.Draw,
      away: values[event.away_team]
    };

    if (!row.home || !row.draw || !row.away) continue;
    const score = row.home + row.draw + row.away;
    const bestScore = best ? best.home + best.draw + best.away : 0;
    if (!best || score > bestScore) best = row;
  }
  return best;
}

function oldRemoveMargin(odds) {
  if (!odds) return null;
  const raw = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const total = raw.reduce((a, b) => a + b, 0);
  return {
    home: raw[0] / total,
    draw: raw[1] / total,
    away: raw[2] / total
  };
}

function oldClassify(item, event) {
  if (!item.model || item.dataQuality < config.minDataQuality) {
    return {
      ...item,
      category: "wait",
      reason: item.reason || "Data Quality ниже рабочего порога."
    };
  }

  const odds = oldBestH2H(event);
  if (!odds) {
    return {
      ...item,
      category: "wait",
      reason: "Коэффициенты не найдены. Нельзя подтвердить value.",
      odds: null
    };
  }

  const market = oldRemoveMargin(odds);
  const candidates = [
    { side: "П1", key: "home", probability: item.model.home, odds: odds.home },
    { side: "X", key: "draw", probability: item.model.draw, odds: odds.draw },
    { side: "П2", key: "away", probability: item.model.away, odds: odds.away }
  ].map(candidate => ({
    ...candidate,
    edge: (candidate.probability - market[candidate.key]) * 100,
    ev: (candidate.probability * candidate.odds - 1) * 100,
    fairOdds: 1 / candidate.probability
  })).sort((a, b) => b.edge - a.edge);

  const best = candidates[0];
  const confidence = Math.round(
    Math.min(88, item.dataQuality * 0.55 + Math.max(0, best.edge) * 2.4 + 18)
  );

  const result = {
    ...item,
    odds,
    bookmaker: odds.bookmaker,
    marketProbability: market,
    candidate: best,
    confidence
  };

  if (best.edge >= config.minEdgePercent && best.ev >= 4 && confidence >= 70) {
    return { ...result, category: "value" };
  }

  if (best.edge >= Math.max(1.5, config.minEdgePercent - 2)) {
    return {
      ...result,
      category: "near",
      reason: `Не прошли все пороги: Edge ${best.edge.toFixed(1)}%, EV ${best.ev.toFixed(1)}%, Confidence ${confidence}.`
    };
  }

  return {
    ...result,
    category: "rejected",
    reason: "Преимущество над рынком недостаточно."
  };
}

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} != ${expected}`);
}

const oldModel = oldBuildModel(fixture, context);
const newModel = buildModel(fixture, context);
close(newModel.model.home, oldModel.model.home, "model.home");
close(newModel.model.draw, oldModel.model.draw, "model.draw");
close(newModel.model.away, oldModel.model.away, "model.away");
close(newModel.model.expectedGoals, oldModel.model.expectedGoals, "expectedGoals");
assert.equal(newModel.dataQuality, oldModel.dataQuality);

const matchedOddsEvent = findOddsEvent(fixture, [oddsEvent]);
const oldDecision = oldClassify(oldModel, oddsEvent);
const newDecision = classify(newModel, matchedOddsEvent, config);

assert.equal(newDecision.category, oldDecision.category);
assert.equal(newDecision.candidate.side, oldDecision.candidate.side);
close(newDecision.candidate.probability, oldDecision.candidate.probability, "candidate.probability");
close(newDecision.candidate.fairOdds, oldDecision.candidate.fairOdds, "candidate.fairOdds");
close(newDecision.candidate.edge, oldDecision.candidate.edge, "candidate.edge");
close(newDecision.candidate.ev, oldDecision.candidate.ev, "candidate.ev");

console.log("Parity OK: model probability, fair odds, edge, EV and category match baseline.");
