import { SourceStatus } from "../providerResult.js";
import { matchOddsEvent } from "../../market/oddsMatching.js";
import { oddsProviderPrimary } from "./primaryOdds.js";
import { oddsProviderSecondary } from "./secondaryOdds.js";

function providerResultLike(result) {
  return {
    status: result.status,
    source: result.source,
    fetchedAt: result.fetchedAt,
    data: result.events || [],
    error: result.error,
    meta: result.meta
  };
}

function attachMarketMeta(event, meta) {
  return event ? { ...event, marketMeta: meta } : null;
}

export async function aggregateMarket({
  request,
  config,
  sportKey,
  fixtures,
  marketCache,
  now = new Date()
}) {
  const primary = await oddsProviderPrimary({
    request,
    oddsApiKey: config.oddsApiKey,
    oddsRegion: config.oddsRegion,
    sportKey
  });
  const secondary = await oddsProviderSecondary();
  const byFixtureId = {};
  const diagnostics = {};
  const providerResults = [
    providerResultLike(primary),
    providerResultLike(secondary)
  ];

  for (const fixture of fixtures) {
    const primaryMatch = matchOddsEvent(
      { ...fixture, sportKey },
      primary.events,
      config.marketMatchMinConfidence
    );
    if (primaryMatch.event && primary.status === SourceStatus.OK) {
      const event = attachMarketMeta(primaryMatch.event, {
        source: primary.source,
        sourcePriority: "PRIMARY",
        freshness: "FRESH",
        observedAt: primary.fetchedAt,
        matchingConfidence: primaryMatch.confidence
      });
      byFixtureId[fixture.id] = event;
      diagnostics[fixture.id] = { source: "PRIMARY", confidence: primaryMatch.confidence };
      marketCache.appendFixtureOdds({
        fixture,
        oddsEvent: event,
        source: primary.source,
        observedAt: primary.fetchedAt,
        matchingConfidence: primaryMatch.confidence,
        revisionThreshold: config.oddsRevisionThreshold
      });
      continue;
    }

    const cached = marketCache.cachedEventForFixture(fixture, now, config);
    if (cached) {
      byFixtureId[fixture.id] = cached;
      diagnostics[fixture.id] = {
        source: "CACHE",
        freshness: cached.marketMeta.freshness,
        observedAt: cached.marketMeta.observedAt,
        primaryStatus: primary.status,
        primaryDiagnostic: primaryMatch.diagnostic
      };
      continue;
    }

    diagnostics[fixture.id] = {
      source: "NONE",
      primaryStatus: primary.status,
      primaryDiagnostic: primaryMatch.diagnostic
    };
  }

  providerResults.push({
    status: SourceStatus.OK,
    source: "market.cache",
    fetchedAt: new Date(now).toISOString(),
    data: [],
    error: null,
    meta: marketCache.summary(now, config)
  });

  return {
    status: primary.status === SourceStatus.OK ? SourceStatus.OK : primary.status,
    source: "market.aggregate",
    fetchedAt: new Date(now).toISOString(),
    byFixtureId,
    diagnostics,
    providerResults,
    meta: {
      primaryStatus: primary.status,
      secondaryStatus: secondary.status,
      cache: marketCache.summary(now, config),
      primaryBackoff: primary.status === SourceStatus.QUOTA
        ? { reason: "QUOTA", retryAfterMinutes: config.oddsStaleMinutes }
        : null
    }
  };
}
