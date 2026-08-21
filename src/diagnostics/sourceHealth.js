import { SourceStatus } from "../providers/providerResult.js";

export function createSourceHealth(results = []) {
  const bySource = {};
  const grouped = new Map();
  for (const result of results.filter(Boolean)) {
    if (!grouped.has(result.source)) grouped.set(result.source, []);
    grouped.get(result.source).push(result);
  }
  for (const [source, rows] of grouped.entries()) {
    const last = rows.at(-1);
    const okCount = rows.filter(row => row.status === SourceStatus.OK).length;
    const partialCount = rows.filter(row => row.status === SourceStatus.PARTIAL).length;
    const status = okCount
      ? (okCount === rows.length ? SourceStatus.OK : SourceStatus.PARTIAL)
      : partialCount
        ? SourceStatus.PARTIAL
        : rows.some(row => row.status === SourceStatus.QUOTA)
          ? SourceStatus.QUOTA
          : rows.some(row => row.status === SourceStatus.ERROR)
            ? SourceStatus.ERROR
            : SourceStatus.NA;
    const coverageRows = rows.filter(row => Array.isArray(row.data));
    const successful = rows.filter(row => [SourceStatus.OK, SourceStatus.PARTIAL].includes(row.status));
    const meta = rows.length === 1 ? (last.meta || {}) : {
      ...(last.meta || {}),
      aggregated: true,
      resultsCount: rows.length,
      requestsUsed: rows.reduce((sum, row) => sum + (row.meta?.requestsUsed || 0), 0),
      cacheHits: rows.reduce((sum, row) => sum + (row.meta?.cacheHits || 0), 0),
      eventsReceived: rows.reduce((sum, row) => sum + (row.meta?.eventsReceived || 0), 0),
      matchedFixtures: rows.reduce((sum, row) => sum + (row.meta?.matchedFixtures || 0), 0)
    };
    bySource[source] = {
      status,
      fetchedAt: last.fetchedAt,
      lastSuccessfulFetch: successful.at(-1)?.fetchedAt || null,
      coverageCount: coverageRows.length ? coverageRows.reduce((sum, row) => sum + row.data.length, 0) : null,
      error: rows.find(row => row.error)?.error || null,
      meta
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
    `odds-api.io: ${sourceHealth["odds-api-io"]?.status || SourceStatus.NA}`,
    `odds secondary: ${sourceHealth["odds.secondary"]?.status || SourceStatus.NA}`,
    `market cache: ${sourceHealth["market.cache"]?.status || SourceStatus.NA}`,
    `API-Football: ${sourceHealth["api-football"]?.status || SourceStatus.NA}`,
    "xG: NOT CONNECTED"
  ];
}
