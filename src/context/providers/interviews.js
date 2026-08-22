import { providerResult, SourceStatus } from "../../providers/providerResult.js";
export async function fetchInterviewContext({ sources = [] } = {}) {
  return providerResult({ status: SourceStatus.NA, source: "context.interviews", data: [], meta: { configuredSources: sources.length, reason: "NO_VERIFIED_SOURCES_CONFIGURED" } });
}
