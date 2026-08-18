import { errorResult, providerResult, SourceStatus } from "./providerResult.js";

function classifyOddsError(error) {
  const message = error.message || "";
  if (message.includes("OUT_OF_USAGE_CREDITS") || message.includes("usage credits")) {
    return SourceStatus.QUOTA;
  }
  if (message.startsWith("401") || message.startsWith("403")) {
    return SourceStatus.ERROR;
  }
  if (message.includes("timeout")) {
    return SourceStatus.ERROR;
  }
  return SourceStatus.ERROR;
}

export async function fetchOddsForSport({ request, oddsApiKey, oddsRegion, sportKey }) {
  const source = sportKey ? `odds.${sportKey}` : "odds";

  if (!oddsApiKey) {
    return providerResult({
      status: SourceStatus.NA,
      source,
      data: [],
      meta: { sportKey, reason: "THE_ODDS_API_KEY is not configured" }
    });
  }

  if (!sportKey) {
    return providerResult({
      status: SourceStatus.NA,
      source,
      data: [],
      meta: { sportKey, reason: "Unsupported league" }
    });
  }

  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`);
  url.searchParams.set("apiKey", oddsApiKey);
  url.searchParams.set("regions", oddsRegion);
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "decimal");

  try {
    const data = await request(url);
    return providerResult({
      status: data.length ? SourceStatus.OK : SourceStatus.NA,
      source,
      data,
      meta: { sportKey, oddsRegion, empty: data.length === 0 }
    });
  } catch (error) {
    const result = errorResult(source, error, { sportKey, oddsRegion });
    result.status = classifyOddsError(error);
    return result;
  }
}
