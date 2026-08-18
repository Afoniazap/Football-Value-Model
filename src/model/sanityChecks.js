export function runSanityChecks({ item, dataQuality, minDataQuality }) {
  const warnings = [];
  const bestProbability = Math.max(
    item.model?.home || 0,
    item.model?.draw || 0,
    item.model?.away || 0
  );

  if (bestProbability >= 0.9 && dataQuality.scoreNormalized < minDataQuality) {
    warnings.push({
      code: "SANITY_REVIEW_REQUIRED",
      reason: "PROBABILITY_HIGH_WITH_LOW_DQ",
      message: "Model probability is >= 0.90 while DQ is below threshold."
    });
  }

  if (item.candidate) {
    if (item.candidate.fairOdds < 1.1 || item.candidate.fairOdds > 20) {
      warnings.push({
        code: "SANITY_REVIEW_REQUIRED",
        reason: "EXTREME_FAIR_ODDS",
        message: "Fair odds are outside the normal review band."
      });
    }
    if (item.candidate.ev > 100) {
      warnings.push({
        code: "SANITY_REVIEW_REQUIRED",
        reason: "EV_OVER_100",
        message: "EV is above 100%."
      });
    }
    if (item.candidate.edge > 30) {
      warnings.push({
        code: "SANITY_REVIEW_REQUIRED",
        reason: "EDGE_OVER_30PP",
        message: "Edge is above 30 percentage points."
      });
    }
    const marketProbability = item.marketProbability?.[item.candidate.key];
    if (marketProbability && Math.abs(item.candidate.probability - marketProbability) > 0.3) {
      warnings.push({
        code: "SANITY_REVIEW_REQUIRED",
        reason: "MODEL_MARKET_DIVERGENCE",
        message: "Model probability differs from market probability by more than 30 percentage points."
      });
    }
  }

  return warnings;
}
