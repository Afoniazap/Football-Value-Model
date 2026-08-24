function fallbackCategory(candidate, config) {
  return candidate?.edge >= Math.max(1.5, config.minEdgePercent - 2) ? "near" : "rejected";
}

function penaltyForGap(gapPp, warnPp, rejectPp) {
  if (gapPp <= warnPp) return 0;
  if (gapPp > rejectPp) return 12;
  const range = Math.max(0.1, rejectPp - warnPp);
  return Math.max(1, Math.round(((gapPp - warnPp) / range) * 6));
}

export function applyShadowDisagreementGate({ item, shadow, risk, config }) {
  const candidate = item.candidate;
  const shadowProbability = candidate?.key ? shadow?.challenger?.probabilities?.[candidate.key] : null;
  const mainProbability = candidate?.probability ?? null;
  const warnPp = config.shadowDisagreementWarnPp;
  const rejectPp = config.shadowDisagreementRejectPp;
  if (!Number.isFinite(mainProbability) || !Number.isFinite(shadowProbability)) {
    const gate = { mainProbability, shadowProbability, modelDisagreementPp: null, shadowGateStatus: "N/A", shadowGateReason: "Independent Shadow probability is unavailable", confidencePenalty: 0, riskPenalty: 0 };
    return { item: { ...item, ...gate }, risk, gate };
  }
  const modelDisagreementPp = Number((Math.abs(mainProbability - shadowProbability) * 100).toFixed(4));
  const shadowGateStatus = modelDisagreementPp > rejectPp ? "BLOCK" : modelDisagreementPp > warnPp ? "WARN" : "OK";
  const penalty = penaltyForGap(modelDisagreementPp, warnPp, rejectPp);
  const shadowGateReason = shadowGateStatus === "OK" ? null : `Main/Shadow disagreement too high: ${modelDisagreementPp.toFixed(1)} pp > ${(shadowGateStatus === "BLOCK" ? rejectPp : warnPp).toFixed(1)} pp`;
  const adjustedConfidence = Number.isFinite(item.confidence) ? Math.max(0, item.confidence - penalty) : item.confidence;
  const adjustedRisk = risk ? {
    ...risk,
    score: Math.max(0, risk.score - penalty),
    redFlags: shadowGateStatus === "OK" ? risk.redFlags : [...(risk.redFlags || []), { code: "SHADOW_MODEL_DISAGREEMENT", severity: shadowGateStatus === "BLOCK" ? "HIGH" : "MEDIUM", message: shadowGateReason, source: "shadow.challenger" }]
  } : risk;
  let category = item.category;
  let reason = item.reason;
  if (shadowGateStatus === "BLOCK" && category === "value") {
    category = fallbackCategory(candidate, config);
    reason = shadowGateReason;
  } else if (shadowGateStatus === "WARN" && category === "value" && adjustedConfidence < 70) {
    category = fallbackCategory(candidate, config);
    reason = `${shadowGateReason}; Confidence after penalty ${adjustedConfidence}/100 < 70/100`;
  }
  const gate = { mainProbability, shadowProbability, modelDisagreementPp, shadowGateStatus, shadowGateReason, confidencePenalty: penalty, riskPenalty: penalty };
  return { item: { ...item, ...gate, confidence: adjustedConfidence, category, reason }, risk: adjustedRisk, gate };
}
