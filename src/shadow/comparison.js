import { bestH2H } from "../market/oddsMatching.js";
import { removeMargin } from "../market/margin.js";
import { buildChallengerModel, CHALLENGER_VARIANTS } from "../model/challenger/probability.js";
import { applyTemperature } from "../model/challenger/calibration.js";

export const CHALLENGER_TEMPERATURE = 1.175;
export const CHALLENGER_MODEL_V1_CALIBRATED = "CHALLENGER_MODEL_V1_CALIBRATED";

const SIDES = [
  { side: "П1", key: "home" },
  { side: "X", key: "draw" },
  { side: "П2", key: "away" }
];

export function topPick(model) {
  if (!model) return null;
  return SIDES
    .map(item => ({ ...item, probability: model[item.key] }))
    .sort((a, b) => b.probability - a.probability)[0];
}

export function disagreementStatus(differences) {
  const max = differences?.maxProbabilityDifference ?? 0;
  if (max < 0.05) return "MODEL_AGREE";
  if (max <= 0.10) return "MODEL_MILD_DISAGREEMENT";
  return "MODEL_STRONG_DISAGREEMENT";
}

export function probabilityDifferences(baselineModel, challengerModel) {
  if (!baselineModel || !challengerModel) return null;
  const byClass = {
    home: Math.abs(baselineModel.home - challengerModel.home),
    draw: Math.abs(baselineModel.draw - challengerModel.draw),
    away: Math.abs(baselineModel.away - challengerModel.away)
  };
  return {
    ...byClass,
    maxProbabilityDifference: Math.max(byClass.home, byClass.draw, byClass.away)
  };
}

function marketCandidates(model, oddsEvent, config, dataQuality = 70) {
  if (!model) return { status: "N/A", candidates: [], selected: null };
  const odds = bestH2H(oddsEvent);
  if (!odds) return { status: "N/A", candidates: [], selected: null };
  const market = removeMargin(odds);
  const candidates = SIDES.map(item => ({
    ...item,
    probability: model[item.key],
    odds: odds[item.key],
    marketProbability: market[item.key],
    fairOdds: 1 / model[item.key],
    edge: (model[item.key] - market[item.key]) * 100,
    ev: (model[item.key] * odds[item.key] - 1) * 100,
    bookmaker: odds.bookmaker
  })).sort((a, b) => b.edge - a.edge);

  const selected = candidates[0];
  const confidence = Math.round(
    Math.min(88, dataQuality * 0.55 + Math.max(0, selected.edge) * 2.4 + 18)
  );
  const category = selected.edge >= config.minEdgePercent && selected.ev >= 4 && confidence >= 70
    ? "value"
    : selected.edge >= Math.max(1.5, config.minEdgePercent - 2)
      ? "near"
      : "rejected";

  return { status: "OK", market, candidates, selected, category, confidence };
}

export function buildCalibratedChallenger(fixture, context) {
  const raw = buildChallengerModel(fixture, context, CHALLENGER_VARIANTS.POISSON_ELO_FORM);
  if (!raw.model) return { ...raw, shadowStatus: "N/A", model: null };
  const calibrated = applyTemperature(raw.model, CHALLENGER_TEMPERATURE);
  return {
    ...raw,
    modelVersion: CHALLENGER_MODEL_V1_CALIBRATED,
    shadowStatus: "OK",
    model: {
      ...raw.model,
      ...calibrated,
      raw: {
        home: raw.model.home,
        draw: raw.model.draw,
        away: raw.model.away
      },
      calibration: {
        method: "temperature",
        temperature: CHALLENGER_TEMPERATURE
      }
    }
  };
}

export function buildShadowComparison({ fixture, context, baseline, oddsEvent, config, providerHealth }) {
  if (!baseline.model || !context?.matches?.length) {
    return {
      shadowStatus: "N/A",
      officialModel: "BASELINE_MODEL_V04",
      challengerModel: CHALLENGER_MODEL_V1_CALIBRATED,
      reason: "Insufficient independent pre-match data",
      providerHealth
    };
  }

  const challenger = buildCalibratedChallenger(fixture, context);
  const differences = probabilityDifferences(baseline.model, challenger.model);
  const baselineMarket = marketCandidates(baseline.model, oddsEvent, config, baseline.dataQuality);
  const challengerMarket = marketCandidates(challenger.model, oddsEvent, config, baseline.dataQuality);
  const baselineTop = topPick(baseline.model);
  const challengerTop = topPick(challenger.model);

  return {
    shadowStatus: challenger.model ? "OK" : "N/A",
    officialModel: "BASELINE_MODEL_V04",
    challengerModel: CHALLENGER_MODEL_V1_CALIBRATED,
    baseline: {
      probabilities: baseline.model ? {
        home: baseline.model.home,
        draw: baseline.model.draw,
        away: baseline.model.away
      } : null,
      topPick: baselineTop,
      market: baselineMarket,
      category: baseline.category
    },
    challenger: {
      probabilities: challenger.model ? {
        home: challenger.model.home,
        draw: challenger.model.draw,
        away: challenger.model.away
      } : null,
      topPick: challengerTop,
      market: challengerMarket,
      shadowCategory: challengerMarket.category || "wait"
    },
    differences,
    topPickAgreement: Boolean(baselineTop && challengerTop && baselineTop.key === challengerTop.key),
    disagreementStatus: differences ? disagreementStatus(differences) : "MODEL_N/A",
    providerHealth
  };
}
