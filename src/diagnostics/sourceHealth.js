import { SourceStatus } from "../providers/providerResult.js";

export function createSourceHealth(results = []) {
  const bySource = {};
  for (const result of results.filter(Boolean)) {
    bySource[result.source] = {
      status: result.status,
      fetchedAt: result.fetchedAt,
      lastSuccessfulFetch: result.status === SourceStatus.OK ? result.fetchedAt : null,
      coverageCount: Array.isArray(result.data) ? result.data.length : null,
      error: result.error,
      meta: result.meta || {}
    };
  }

  const apiFootballResults = results.filter(result => result?.source?.startsWith("api-football."));
  const apiFootballOk = apiFootballResults.filter(result => result.status === SourceStatus.OK).length;
  const apiFootballQuota = apiFootballResults.some(result => result.status === SourceStatus.QUOTA);
  const apiFootballError = apiFootballResults.some(result => result.status === SourceStatus.ERROR);
  const apiFootballPartial = apiFootballResults.some(result => result.status === SourceStatus.PARTIAL);
  bySource["api-football"] = {
    status: apiFootballOk
      ? (apiFootballOk === apiFootballResults.length ? SourceStatus.OK : SourceStatus.PARTIAL)
      : apiFootballQuota
        ? SourceStatus.QUOTA
        : apiFootballError
          ? SourceStatus.ERROR
          : apiFootballPartial
            ? SourceStatus.PARTIAL
            : SourceStatus.NA,
    fetchedAt: apiFootballResults.at(-1)?.fetchedAt || null,
    lastSuccessfulFetch: apiFootballResults.find(result => result.status === SourceStatus.OK)?.fetchedAt || null,
    coverageCount: apiFootballOk,
    error: apiFootballResults.find(result => result.error)?.error || null,
    meta: apiFootballResults.length ? { fixturesChecked: apiFootballResults.length } : { reason: "NOT CONNECTED" }
  };

  bySource.xg = {
    status: SourceStatus.NA,
    fetchedAt: null,
    lastSuccessfulFetch: null,
    coverageCount: 0,
    error: null,
    meta: { reason: "NOT CONNECTED" }
  };

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
    `odds secondary: ${sourceHealth["odds.secondary"]?.status || SourceStatus.NA}`,
    `market cache: ${sourceHealth["market.cache"]?.status || SourceStatus.NA}`,
    `API-Football: ${sourceHealth["api-football"]?.status || SourceStatus.NA}`,
    "xG: NOT CONNECTED"
  ];
}
