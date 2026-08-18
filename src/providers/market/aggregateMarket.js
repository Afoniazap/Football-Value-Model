import { SourceStatus } from "../providerResult.js";
import { bestH2H, matchOddsEvent } from "../../market/oddsMatching.js";
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

function providerAvailable(provider) {
  return [SourceStatus.OK, SourceStatus.PARTIAL].includes(provider.status);
}

function agreement(primaryEvent, secondaryEvent) {
  const primary = bestH2H(primaryEvent);
  const secondary = bestH2H(secondaryEvent);
  if (!primary || !secondary) return null;
  const rows = {};
  for (const key of ["home", "draw", "away"]) {
    const values = [
      { source: primaryEvent.marketMeta?.source || "PRIMARY", odds: primary[key] },
      { source: secondaryEvent.marketMeta?.source || "SECONDARY", odds: secondary[key] }
    ].filter(row => Number.isFinite(Number(row.odds)));
    const odds = values.map(row => Number(row.odds)).sort((a, b) => a - b);
    rows[key] = {
      sourceCount: values.length,
      min: odds[0] ?? null,
      max: odds.at(-1) ?? null,
      median: odds.length ? odds[Math.floor(odds.length / 2)] : null,
      spread: odds.length > 1 ? odds.at(-1) - odds[0] : null,
      quotes: values
    };
  }
  return rows;
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
  const secondary = await oddsProviderSecondary({
    request,
    apiFootballKey: config.apiFootballKey,
    fixtures,
    root: config.root,
    now,
    cacheMinutes: config.apiFootballOddsCacheMinutes
  });
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
    const secondaryMatch = matchOddsEvent(
      { ...fixture, sportKey },
      secondary.events,
      config.marketMatchMinConfidence
    );
    const primaryEventForDiagnostics = primaryMatch.event ? attachMarketMeta(primaryMatch.event, {
      source: primary.source,
      sourcePriority: "PRIMARY",
      freshness: "FRESH",
      observedAt: primary.fetchedAt,
      matchingConfidence: primaryMatch.confidence
    }) : null;
    const secondaryEventForDiagnostics = secondaryMatch.event ? attachMarketMeta(secondaryMatch.event, {
      source: "API_FOOTBALL",
      sourcePriority: "SECONDARY",
      freshness: "FRESH",
      observedAt: secondary.fetchedAt,
      matchingConfidence: secondaryMatch.confidence
    }) : null;
    const marketAgreement = primaryEventForDiagnostics && secondaryEventForDiagnostics
      ? agreement(primaryEventForDiagnostics, secondaryEventForDiagnostics)
      : null;

    if (primaryMatch.event && primary.status === SourceStatus.OK) {
      const event = attachMarketMeta(primaryMatch.event, {
        source: primary.source,
        sourcePriority: "PRIMARY",
        freshness: "FRESH",
        observedAt: primary.fetchedAt,
        matchingConfidence: primaryMatch.confidence
      });
      byFixtureId[fixture.id] = event;
      diagnostics[fixture.id] = {
        source: "PRIMARY",
        confidence: primaryMatch.confidence,
        secondaryStatus: secondary.status,
        secondaryConfidence: secondaryMatch.confidence,
        marketAgreement
      };
      marketCache.appendFixtureOdds({
        fixture,
        oddsEvent: event,
        source: primary.source,
        observedAt: primary.fetchedAt,
        matchingConfidence: primaryMatch.confidence,
        revisionThreshold: config.oddsRevisionThreshold
      });
      if (secondaryEventForDiagnostics) {
        marketCache.appendFixtureOdds({
          fixture,
          oddsEvent: secondaryEventForDiagnostics,
          source: "API_FOOTBALL",
          observedAt: secondary.fetchedAt,
          matchingConfidence: secondaryMatch.confidence,
          revisionThreshold: config.oddsRevisionThreshold
        });
      }
      continue;
    }

    if (secondaryMatch.event && providerAvailable(secondary)) {
      const event = attachMarketMeta(secondaryMatch.event, {
        source: "API_FOOTBALL",
        sourcePriority: "SECONDARY",
        freshness: "FRESH",
        observedAt: secondary.fetchedAt,
        matchingConfidence: secondaryMatch.confidence,
        fallbackReason: `primary:${primary.status}`
      });
      byFixtureId[fixture.id] = event;
      diagnostics[fixture.id] = {
        source: "SECONDARY",
        confidence: secondaryMatch.confidence,
        primaryStatus: primary.status,
        primaryDiagnostic: primaryMatch.diagnostic,
        fallbackReason: `primary:${primary.status}`,
        marketAgreement
      };
      marketCache.appendFixtureOdds({
        fixture,
        oddsEvent: event,
        source: "API_FOOTBALL",
        observedAt: secondary.fetchedAt,
        matchingConfidence: secondaryMatch.confidence,
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
        secondaryStatus: secondary.status,
        primaryDiagnostic: primaryMatch.diagnostic,
        secondaryDiagnostic: secondaryMatch.diagnostic,
        fallbackReason: "providers_unavailable_or_unmatched"
      };
      continue;
    }

    diagnostics[fixture.id] = {
      source: "NONE",
      primaryStatus: primary.status,
      secondaryStatus: secondary.status,
      primaryDiagnostic: primaryMatch.diagnostic,
      secondaryDiagnostic: secondaryMatch.diagnostic
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
  const usageCounts = Object.values(diagnostics).reduce((acc, item) => {
    acc[item.source] = (acc[item.source] || 0) + 1;
    return acc;
  }, {});
  const matchedCount = Object.values(diagnostics).filter(item =>
    ["PRIMARY", "SECONDARY", "CACHE"].includes(item.source)
  ).length;
  const rejectedByMatching = Object.values(diagnostics).filter(item =>
    item.primaryDiagnostic === "MATCH_LOW_CONFIDENCE" || item.secondaryDiagnostic === "MATCH_LOW_CONFIDENCE"
  ).length;

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
      secondaryRequestsUsed: secondary.requestsUsed || 0,
      secondaryFixturesReceived: secondary.meta?.fixturesReceived || 0,
      fixturesSuccessfullyMatched: matchedCount,
      fixturesRejectedByMatching: rejectedByMatching,
      marketCoveragePercent: fixtures.length ? (matchedCount / fixtures.length) * 100 : 0,
      usageCounts,
      cache: marketCache.summary(now, config),
      primaryBackoff: primary.status === SourceStatus.QUOTA
        ? { reason: "QUOTA", retryAfterMinutes: config.oddsStaleMinutes }
        : null
    }
  };
}
