import { providerResult, SourceStatus } from "../providerResult.js";

export async function oddsProviderSecondary() {
  const result = providerResult({
    status: SourceStatus.NA,
    source: "odds.secondary",
    data: [],
    meta: { reason: "NOT CONNECTED" }
  });
  return {
    status: result.status,
    source: result.source,
    fetchedAt: result.fetchedAt,
    events: [],
    meta: result.meta,
    error: null
  };
}
