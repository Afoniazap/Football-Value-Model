export const XG_STATUS = Object.freeze({
  OK: "OK",
  PARTIAL: "PARTIAL",
  NA: "N/A",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NOT_COVERED: "NOT_COVERED",
  QUOTA: "QUOTA",
  PLAN_REQUIRED: "PLAN_REQUIRED",
  ERROR: "ERROR"
});

export function xgProviderResult({
  status,
  source,
  records = [],
  error = null,
  meta = {}
}) {
  return {
    status,
    source,
    fetchedAt: new Date().toISOString(),
    records,
    error,
    meta
  };
}

export function classifyXgHttpError(error) {
  const message = error.message || "";
  const lower = message.toLowerCase();
  if (message.startsWith("429") || lower.includes("quota") || lower.includes("rate limit")) return XG_STATUS.QUOTA;
  if (message.startsWith("401") || message.startsWith("403") || lower.includes("plan") || lower.includes("subscription")) {
    return XG_STATUS.PLAN_REQUIRED;
  }
  if (lower.includes("not covered") || lower.includes("coverage")) return XG_STATUS.NOT_COVERED;
  return XG_STATUS.ERROR;
}

export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sideMetrics(side = {}) {
  return {
    xG: numberOrNull(side.xG),
    npxG: numberOrNull(side.npxG),
    xGA: numberOrNull(side.xGA)
  };
}

export function normalizeXgRecord({
  fixtureId,
  externalFixtureId,
  kickoff,
  competition,
  home,
  away,
  source,
  observedAt,
  status = XG_STATUS.OK,
  coverage = "FULL",
  metricVersion = "actual-xg-v1",
  providerMeta = {}
}) {
  return {
    fixtureId: fixtureId ? String(fixtureId) : null,
    externalFixtureId: externalFixtureId ? String(externalFixtureId) : null,
    kickoff,
    competition: competition || null,
    home: sideMetrics(home),
    away: sideMetrics(away),
    source,
    observedAt: observedAt || new Date().toISOString(),
    status,
    coverage,
    metricVersion,
    providerMeta
  };
}

export function xgCoverage(record) {
  if (!record) return "N/A";
  const values = [
    record.home?.xG,
    record.home?.npxG,
    record.home?.xGA,
    record.away?.xG,
    record.away?.npxG,
    record.away?.xGA
  ];
  const present = values.filter(value => Number.isFinite(value)).length;
  if (present >= 4 && Number.isFinite(record.home?.xG) && Number.isFinite(record.away?.xG)) return "FULL";
  if (present > 0) return "PARTIAL";
  return "N/A";
}
