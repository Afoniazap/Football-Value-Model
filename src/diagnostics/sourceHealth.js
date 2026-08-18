import { SourceStatus } from "../providers/providerResult.js";

export function createSourceHealth(results = []) {
  const bySource = {};
  for (const result of results.filter(Boolean)) {
    bySource[result.source] = {
      status: result.status,
      fetchedAt: result.fetchedAt,
      error: result.error,
      meta: result.meta || {}
    };
  }

  if (!bySource["api-football"]) {
    bySource["api-football"] = {
      status: SourceStatus.NA,
      fetchedAt: null,
      error: null,
      meta: { reason: "NOT CONNECTED" }
    };
  }

  return bySource;
}

export function healthLines(sourceHealth = {}) {
  const football = sourceHealth["football-data.fixtures"]?.status || SourceStatus.NA;
  const oddsStatuses = Object.entries(sourceHealth)
    .filter(([source]) => source === "odds" || source.startsWith("odds."))
    .map(([, value]) => value.status);
  const odds = oddsStatuses.includes(SourceStatus.OK)
    ? SourceStatus.OK
    : oddsStatuses.includes(SourceStatus.QUOTA)
      ? SourceStatus.QUOTA
      : oddsStatuses.includes(SourceStatus.ERROR)
        ? SourceStatus.ERROR
        : SourceStatus.NA;

  return [
    `football-data: ${football}`,
    `odds: ${odds}`,
    "API-Football: NOT CONNECTED"
  ];
}
