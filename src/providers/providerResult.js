export const SourceStatus = Object.freeze({
  OK: "OK",
  PARTIAL: "PARTIAL",
  NA: "N/A",
  QUOTA: "QUOTA",
  ERROR: "ERROR"
});

export function providerResult({ status, source, data = null, error = null, meta = {} }) {
  return {
    status,
    source,
    fetchedAt: new Date().toISOString(),
    data,
    error,
    meta
  };
}

export function errorResult(source, error, meta = {}) {
  return providerResult({
    status: SourceStatus.ERROR,
    source,
    data: null,
    error: {
      code: error.code || error.name || "ERROR",
      message: error.message || String(error)
    },
    meta
  });
}
