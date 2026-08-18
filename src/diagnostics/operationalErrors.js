export const ERROR_CATEGORY = Object.freeze({
  CONFIG: "CONFIG",
  NETWORK: "NETWORK",
  AUTH: "AUTH",
  QUOTA: "QUOTA",
  PLAN_LIMIT: "PLAN_LIMIT",
  MATCHING: "MATCHING",
  SOURCE_SCHEMA: "SOURCE_SCHEMA",
  DATA_MISSING: "DATA_MISSING",
  INTERNAL: "INTERNAL"
});

export const SEVERITY = Object.freeze({
  INFO: "INFO",
  WARNING: "WARNING",
  ERROR: "ERROR",
  CRITICAL: "CRITICAL"
});

export function classifyOperationalError(error = {}, source = "system") {
  const code = String(error.code || error.reason || error.name || "");
  const message = String(error.message || error || "");
  const lower = `${code} ${message}`.toLowerCase();

  if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("429")) return ERROR_CATEGORY.QUOTA;
  if (lower.includes("plan") || lower.includes("subscription") || lower.includes("free plan")) return ERROR_CATEGORY.PLAN_LIMIT;
  if (lower.includes("401") || lower.includes("403") || lower.includes("auth") || lower.includes("unauthorized")) return ERROR_CATEGORY.AUTH;
  if (lower.includes("match") || lower.includes("confidence")) return ERROR_CATEGORY.MATCHING;
  if (lower.includes("schema") || lower.includes("parse") || lower.includes("json")) return ERROR_CATEGORY.SOURCE_SCHEMA;
  if (lower.includes("missing") || lower.includes("not found") || lower.includes("n/a")) return ERROR_CATEGORY.DATA_MISSING;
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("fetch")) return ERROR_CATEGORY.NETWORK;
  if (source === "config") return ERROR_CATEGORY.CONFIG;
  return ERROR_CATEGORY.INTERNAL;
}

export function operationalError({
  source,
  error,
  code = null,
  severity = SEVERITY.ERROR,
  refreshId = null,
  timestamp = new Date().toISOString()
}) {
  return {
    source,
    code: code || classifyOperationalError(error, source),
    severity,
    message: String(error?.message || error || "").slice(0, 300),
    timestamp,
    refreshId
  };
}

export function providerErrors(results = [], refreshId = null) {
  return results
    .filter(result => result?.error)
    .map(result => operationalError({
      source: result.source,
      error: result.error,
      code: classifyOperationalError(result.error, result.source),
      severity: ["QUOTA", "PLAN_LIMIT", "DATA_MISSING"].includes(classifyOperationalError(result.error, result.source))
        ? SEVERITY.WARNING
        : SEVERITY.ERROR,
      refreshId,
      timestamp: result.fetchedAt || new Date().toISOString()
    }));
}
