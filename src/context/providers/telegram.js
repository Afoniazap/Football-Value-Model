import { providerResult, SourceStatus } from "../../providers/providerResult.js";
export async function fetchTelegramContext({ channels = [] } = {}) {
  return providerResult({ status: SourceStatus.NA, source: "context.telegram", data: [], meta: { configuredChannels: channels.length, reason: channels.length ? "INGESTION_ADAPTER_NOT_CONNECTED" : "NO_CHANNELS_CONFIGURED", unverifiedOpinion: true } });
}
