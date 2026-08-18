import { fetchOddsForSport } from "../odds.js";

export async function oddsProviderPrimary({ request, oddsApiKey, oddsRegion, sportKey }) {
  const result = await fetchOddsForSport({ request, oddsApiKey, oddsRegion, sportKey });
  return {
    status: result.status,
    source: result.source,
    fetchedAt: result.fetchedAt,
    events: result.data || [],
    meta: result.meta || {},
    error: result.error || null
  };
}
