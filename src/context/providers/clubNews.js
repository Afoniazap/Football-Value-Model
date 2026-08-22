import { providerResult, SourceStatus } from "../../providers/providerResult.js";
export async function fetchClubNewsContext({ sources = [] } = {}) {
  return providerResult({ status: SourceStatus.NA, source: "context.club-news", data: [], meta: { configuredSources: sources.length, reason: "NO_VERIFIED_SOURCES_CONFIGURED" } });
}
