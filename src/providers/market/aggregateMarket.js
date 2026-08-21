import { SourceStatus } from "../providerResult.js";
import { matchOddsEvent } from "../../market/oddsMatching.js";
import { oddsProviderPrimary } from "./primaryOdds.js";
import { oddsProviderOddsApiIo } from "./oddsApiIo.js";
import { oddsProviderSecondary } from "./secondaryOdds.js";
import { auditCompetitionCoverage, marketSupportClass } from "../../config/competitions.js";

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

function appendProviderOdds({ marketCache, fixture, event, source, observedAt, confidence, config }) {
  if (!event) return;
  marketCache.appendFixtureOdds({
    fixture,
    oddsEvent: event,
    source,
    observedAt,
    matchingConfidence: confidence,
    revisionThreshold: config.oddsRevisionThreshold
  });
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
    sportKey,
    root: config.root,
    runtimeRoot: config.runtimeRoot,
    now
  });
  const primaryMatches = new Map(fixtures.map(fixture => [fixture.id, matchOddsEvent(
    { ...fixture, sportKey },
    primary.events,
    config.marketMatchMinConfidence
  )]));
  const oddsApiIoFixtures = fixtures.filter(fixture => {
    const match = primaryMatches.get(fixture.id);
    return !(match?.event && primary.status === SourceStatus.OK);
  });
  const oddsApiIo = await oddsProviderOddsApiIo({
    request,
    oddsApiIoKey: config.oddsApiIoKey,
    oddsApiIoBookmakers: config.oddsApiIoBookmakers,
    fixtures: oddsApiIoFixtures,
    root: config.root,
    runtimeRoot: config.runtimeRoot,
    now,
    cacheMinutes: config.oddsApiIoCacheMinutes,
    kickoffToleranceMinutes: config.oddsApiIoKickoffToleranceMinutes,
    minConfidence: config.marketMatchMinConfidence
  });
  const oddsApiIoMatches = new Map(fixtures.map(fixture => [fixture.id, matchOddsEvent(
    { ...fixture, sportKey: "football" },
    oddsApiIo.events,
    config.marketMatchMinConfidence
  )]));
  const secondaryFixtures = oddsApiIoFixtures.filter(fixture => {
    const match = oddsApiIoMatches.get(fixture.id);
    return !(match?.event && providerAvailable(oddsApiIo));
  });
  const secondary = await oddsProviderSecondary({
    request,
    apiFootballKey: config.apiFootballKey,
    fixtures: secondaryFixtures,
    root: config.root,
    runtimeRoot: config.runtimeRoot,
    now,
    cacheMinutes: config.apiFootballOddsCacheMinutes
  });
  const byFixtureId = {};
  const diagnostics = {};
  const competitionCoverage = auditCompetitionCoverage(fixtures);
  const providerResults = [
    providerResultLike(primary),
    providerResultLike(oddsApiIo),
    providerResultLike(secondary)
  ];

  for (const fixture of fixtures) {
    const primaryMatch = primaryMatches.get(fixture.id);
    const oddsApiIoMatch = oddsApiIoMatches.get(fixture.id);
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
    const oddsApiIoEventForDiagnostics = oddsApiIoMatch.event ? attachMarketMeta(oddsApiIoMatch.event, {
      source: "ODDS_API_IO",
      sourcePriority: "ODDS_API_IO",
      freshness: "FRESH",
      observedAt: oddsApiIo.fetchedAt,
      matchingConfidence: oddsApiIoMatch.confidence
    }) : null;
    const secondaryEventForDiagnostics = secondaryMatch.event ? attachMarketMeta(secondaryMatch.event, {
      source: "API_FOOTBALL",
      sourcePriority: "SECONDARY",
      freshness: "FRESH",
      observedAt: secondary.fetchedAt,
      matchingConfidence: secondaryMatch.confidence
    }) : null;
    const marketAgreement = null;
    const supportClass = marketSupportClass(fixture.competitionCode);

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
        oddsApiIoStatus: oddsApiIo.status,
        oddsApiIoConfidence: oddsApiIoMatch.confidence,
        secondaryStatus: secondary.status,
        secondaryConfidence: secondaryMatch.confidence,
        marketAgreement
      };
      appendProviderOdds({ marketCache, fixture, event, source: primary.source, observedAt: primary.fetchedAt, confidence: primaryMatch.confidence, config });
      appendProviderOdds({ marketCache, fixture, event: oddsApiIoEventForDiagnostics, source: "ODDS_API_IO", observedAt: oddsApiIo.fetchedAt, confidence: oddsApiIoMatch.confidence, config });
      appendProviderOdds({ marketCache, fixture, event: secondaryEventForDiagnostics, source: "API_FOOTBALL", observedAt: secondary.fetchedAt, confidence: secondaryMatch.confidence, config });
      continue;
    }

    if (oddsApiIoMatch.event && providerAvailable(oddsApiIo)) {
      const event = attachMarketMeta(oddsApiIoMatch.event, {
        source: "ODDS_API_IO",
        sourcePriority: "ODDS_API_IO",
        freshness: "FRESH",
        observedAt: oddsApiIo.fetchedAt,
        matchingConfidence: oddsApiIoMatch.confidence,
        fallbackReason: `primary:${primary.status}`
      });
      byFixtureId[fixture.id] = event;
      diagnostics[fixture.id] = {
        source: "ODDS_API_IO",
        confidence: oddsApiIoMatch.confidence,
        primaryStatus: primary.status,
        primaryDiagnostic: primaryMatch.diagnostic,
        oddsApiIoStatus: oddsApiIo.status,
        oddsApiIoDiagnostic: oddsApiIoMatch.diagnostic,
        secondaryStatus: secondary.status,
        secondaryDiagnostic: secondaryMatch.diagnostic,
        fallbackReason: `primary:${primary.status}`,
        marketAgreement
      };
      appendProviderOdds({ marketCache, fixture, event, source: "ODDS_API_IO", observedAt: oddsApiIo.fetchedAt, confidence: oddsApiIoMatch.confidence, config });
      appendProviderOdds({ marketCache, fixture, event: secondaryEventForDiagnostics, source: "API_FOOTBALL", observedAt: secondary.fetchedAt, confidence: secondaryMatch.confidence, config });
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
        oddsApiIoStatus: oddsApiIo.status,
        oddsApiIoDiagnostic: oddsApiIoMatch.diagnostic,
        fallbackReason: `primary:${primary.status}`,
        marketAgreement
      };
      appendProviderOdds({ marketCache, fixture, event, source: "API_FOOTBALL", observedAt: secondary.fetchedAt, confidence: secondaryMatch.confidence, config });
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
        oddsApiIoStatus: oddsApiIo.status,
        secondaryStatus: secondary.status,
        primaryDiagnostic: primaryMatch.diagnostic,
        oddsApiIoDiagnostic: oddsApiIoMatch.diagnostic,
        secondaryDiagnostic: secondaryMatch.diagnostic,
        fallbackReason: "providers_unavailable_or_unmatched"
      };
      continue;
    }

    diagnostics[fixture.id] = {
      source: "NONE",
      reason: supportClass === "UNSUPPORTED" ? "MARKET_UNSUPPORTED_COMPETITION" : "MARKET_NO_QUOTES",
      support: supportClass,
      primaryStatus: primary.status,
      oddsApiIoStatus: oddsApiIo.status,
      secondaryStatus: secondary.status,
      primaryDiagnostic: primaryMatch.diagnostic,
      oddsApiIoDiagnostic: oddsApiIoMatch.diagnostic,
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
    ["PRIMARY", "ODDS_API_IO", "SECONDARY", "CACHE"].includes(item.source)
  ).length;
  const rejectedByMatching = Object.values(diagnostics).filter(item =>
    item.primaryDiagnostic === "MATCH_LOW_CONFIDENCE" ||
    item.oddsApiIoDiagnostic === "MATCH_LOW_CONFIDENCE" ||
    item.secondaryDiagnostic === "MATCH_LOW_CONFIDENCE"
  ).length;

  return {
    status: [primary.status, oddsApiIo.status, secondary.status].includes(SourceStatus.OK)
      ? SourceStatus.OK
      : primary.status,
    source: "market.aggregate",
    fetchedAt: new Date(now).toISOString(),
    byFixtureId,
    diagnostics,
    providerResults,
    meta: {
      primaryStatus: primary.status,
      oddsApiIoStatus: oddsApiIo.status,
      oddsApiIoRequestsUsed: oddsApiIo.requestsUsed || 0,
      oddsApiIoEventsReceived: oddsApiIo.meta?.eventsReceived || 0,
      oddsApiIoMatchedFixtures: oddsApiIo.meta?.matchedFixtures || 0,
      oddsApiIoCoveragePercent: oddsApiIo.meta?.coveragePercent || 0,
      secondaryStatus: secondary.status,
      secondaryRequestsUsed: secondary.requestsUsed || 0,
      secondaryFixturesReceived: secondary.meta?.fixturesReceived || 0,
      fixturesSuccessfullyMatched: matchedCount,
      fixturesRejectedByMatching: rejectedByMatching,
      marketCoveragePercent: fixtures.length ? (matchedCount / fixtures.length) * 100 : 0,
      competitionCoverage,
      usageCounts,
      cache: marketCache.summary(now, config),
      primaryBackoff: primary.status === SourceStatus.QUOTA
        ? { reason: primary.meta?.reason || "QUOTA", until: primary.meta?.backoffUntil || null }
        : null
    }
  };
}
