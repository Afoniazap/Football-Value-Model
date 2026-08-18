function hasRedFlag(item, code) {
  return (item.diagnostics?.risk?.redFlags || []).some(flag => flag.code === code);
}

export function blockerReasons(item, config) {
  const reasons = new Set();
  const market = item.diagnostics?.market || {};
  const dq = item.diagnostics?.dataQualityV2;
  const risk = item.diagnostics?.risk;
  const sanity = item.diagnostics?.sanityWarnings || [];
  const candidate = item.candidate;

  if (!item.odds && market.source === "NONE") reasons.add("NO_MARKET");
  if (market.freshness === "STALE") reasons.add("STALE_MARKET");
  if ((dq?.scoreNormalized ?? item.dataQuality ?? 0) < config.minDataQuality) reasons.add("LOW_DQ");
  if ((item.confidence ?? 0) < 70) reasons.add("LOW_CONFIDENCE");
  if (!candidate || candidate.edge < config.minEdgePercent) reasons.add("LOW_EDGE");
  if (!candidate || candidate.ev < 4) reasons.add("LOW_EV");
  if ((risk?.score ?? 100) < 70 || hasRedFlag(item, "MARKET_DISAGREEMENT")) reasons.add("HIGH_RISK");
  if (sanity.length) reasons.add("SANITY_REVIEW");
  if (hasRedFlag(item, "SOURCE_PARTIAL")) reasons.add("SOURCE_PARTIAL");
  if (!reasons.size && item.category !== "value") reasons.add("OTHER");
  return [...reasons];
}

export function blockerSummary(processed = [], config) {
  const counts = {
    NO_MARKET: 0,
    STALE_MARKET: 0,
    LOW_DQ: 0,
    LOW_CONFIDENCE: 0,
    LOW_EDGE: 0,
    LOW_EV: 0,
    HIGH_RISK: 0,
    SANITY_REVIEW: 0,
    SOURCE_PARTIAL: 0,
    OTHER: 0
  };
  const byFixture = {};
  for (const item of processed.filter(row => row.category !== "value")) {
    const reasons = blockerReasons(item, config);
    byFixture[item.id] = reasons;
    for (const reason of reasons) counts[reason] = (counts[reason] || 0) + 1;
  }
  return {
    counts,
    byFixture,
    top: Object.entries(counts)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }))
  };
}
