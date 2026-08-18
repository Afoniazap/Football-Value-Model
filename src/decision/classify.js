import { bestH2H } from "../market/oddsMatching.js";
import { removeMargin } from "../market/margin.js";

export function classify(item, event, config) {
  if (!item.model || item.dataQuality < config.minDataQuality) {
    return {
      ...item,
      category: "wait",
      reason: item.reason || "Data Quality ниже рабочего порога."
    };
  }

  const odds = bestH2H(event);
  if (!odds) {
    return {
      ...item,
      category: "wait",
      reason: "Коэффициенты не найдены. Нельзя подтвердить value.",
      odds: null
    };
  }

  const market = removeMargin(odds);
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
