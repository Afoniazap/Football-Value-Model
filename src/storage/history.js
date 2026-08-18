import fs from "node:fs";
import path from "node:path";
import { calculateClv, findClosingQuote } from "../audit/clv.js";
import { cumulativeStatistics, dailyAudit } from "../audit/statistics.js";
import { settleSignal } from "../audit/settlement.js";
import { scoreFinishedShadow, shadowSummary } from "../shadow/scoring.js";

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function appendJsonl(file, row) {
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function signalId(item) {
  const selection = item.candidate?.side || "unknown";
  return `${item.id}:h2h:${selection}:1X2`;
}

function eventId(signalId, type, identity) {
  return `${signalId}:${type}:${identity}`;
}

function oddsRevisionChanged(previous, item, revisionThreshold = 0.02) {
  if (!previous || !item.candidate) return true;
  const previousOdds = Number(previous.latestOdds ?? previous.bookmakerOdds);
  if (!Number.isFinite(previousOdds)) return true;
  return Math.abs(previousOdds - Number(item.candidate.odds)) >= revisionThreshold;
}

function shadowSignalId(item, selection) {
  return `${item.id}:h2h:${selection}:shadow`;
}

function probabilityChanged(previous, baselineProbability, challengerProbability) {
  if (!previous?.baselineProbability || !previous?.challengerProbability) return true;
  return ["home", "draw", "away"].some(key =>
    Math.abs(previous.baselineProbability[key] - baselineProbability[key]) >= 0.001 ||
    Math.abs(previous.challengerProbability[key] - challengerProbability[key]) >= 0.001
  );
}

function oddsChanged(previous, marketOdds, revisionThreshold = 0.02) {
  if (!previous) return true;
  if (previous.marketOdds === null && marketOdds === null) return false;
  if (previous.marketOdds === null || marketOdds === null) return true;
  return Math.abs(Number(previous.marketOdds) - Number(marketOdds)) >= revisionThreshold;
}

function bestSeenOdds(previous, marketOdds) {
  const previousBest = Number(previous?.bestSeenOdds);
  const current = Number(marketOdds);
  if (!Number.isFinite(previousBest)) return Number.isFinite(current) ? current : null;
  if (!Number.isFinite(current)) return previousBest;
  return Math.max(previousBest, current);
}

function oddsHistory(previous, marketOdds, createdAt) {
  const history = Array.isArray(previous?.oddsHistory) ? previous.oddsHistory : [];
  if (marketOdds === null || marketOdds === undefined) return history;
  if (history.at(-1)?.odds === marketOdds) return history;
  return [...history, { at: createdAt, odds: marketOdds }];
}

export function createHistoryStore(root) {
  const historyDir = path.join(root, "data", "history");
  const analysesFile = path.join(historyDir, "analyses.jsonl");
  const signalsFile = path.join(historyDir, "signals.jsonl");
  const officialSignalsFile = path.join(historyDir, "official-signals.jsonl");
  const signalEventsFile = path.join(historyDir, "signal-events.jsonl");
  const settlementsFile = path.join(historyDir, "settlements.jsonl");
  const shadowSignalsFile = path.join(historyDir, "shadow-signals.jsonl");
  const shadowResultsFile = path.join(historyDir, "shadow-results.jsonl");

  function appendAnalysis(snapshot) {
    appendJsonl(analysesFile, snapshot);
  }

  function appendSignals({ analysisId, analysedAt, items, revisionThreshold = 0.02 }) {
    const existing = readJsonl(signalsFile);
    const latestById = new Map();
    for (const row of existing) latestById.set(row.signalId, row);

    for (const item of items.filter(x => ["value", "near"].includes(x.category))) {
      if (!item.candidate) continue;
      const id = signalId(item);
      const previous = latestById.get(id);
      if (previous && !oddsRevisionChanged(previous, item, revisionThreshold)) continue;
      const market = item.diagnostics?.market || {};

      appendJsonl(signalsFile, {
        signalId: id,
        revision: previous ? Number(previous.revision || 1) + 1 : 1,
        analysisId,
        analysedAt,
        fixtureId: item.id,
        utcDate: item.utcDate,
        competition: item.competition,
        home: item.home,
        away: item.away,
        category: item.category,
        market: "h2h",
        selection: item.candidate.side,
        line: "1X2",
        modelProbability: item.candidate.probability,
        fairOdds: item.candidate.fairOdds,
        bookmakerOdds: item.candidate.odds,
        firstSeenOdds: previous?.firstSeenOdds ?? item.candidate.odds,
        latestOdds: item.candidate.odds,
        bestSeenOdds: bestSeenOdds(previous, item.candidate.odds),
        marketSource: market.source || null,
        marketFreshness: market.freshness || null,
        marketObservedAt: market.observedAt || null,
        edge: item.candidate.edge,
        ev: item.candidate.ev,
        bookmaker: item.bookmaker,
        confidence: item.confidence,
        dataQuality: item.dataQuality,
        diagnostics: {
          dataQualityV2: item.diagnostics?.dataQualityV2,
          risk: item.diagnostics?.risk,
          decisionConfidenceV2: item.diagnostics?.decisionConfidenceV2,
          sanityWarnings: item.diagnostics?.sanityWarnings,
          providerHealth: item.diagnostics?.providerHealth
        }
      });
    }
  }

  function appendLifecycleEvent(event) {
    const existing = new Set(readJsonl(signalEventsFile).map(row => row.eventId));
    if (existing.has(event.eventId)) return null;
    appendJsonl(signalEventsFile, event);
    return event;
  }

  function officialSignalFromItem({ analysisId, issuedAt, item, modelVersion }) {
    const market = item.diagnostics?.market || {};
    return {
      signalId: signalId(item),
      fixtureId: item.id,
      competition: item.competition,
      kickoff: item.utcDate,
      market: "h2h",
      selection: item.candidate.side,
      line: "1X2",
      issuedAt,
      analysisId,
      modelVersion,
      productionModel: "BASELINE_MODEL_V04",
      modelProbability: item.candidate.probability,
      fairOdds: item.candidate.fairOdds,
      officialOdds: item.candidate.odds,
      officialBookmaker: item.bookmaker,
      marketSource: market.source || null,
      marketFreshness: market.freshness || null,
      marketObservedAt: market.observedAt || null,
      marketFallbackReason: market.fallbackReason || null,
      edge: item.candidate.edge,
      EV: item.candidate.ev,
      DQ: item.diagnostics?.dataQualityV2 || null,
      DQComponents: item.diagnostics?.dataQualityV2?.components || null,
      Risk: item.diagnostics?.risk || null,
      redFlags: item.diagnostics?.risk?.redFlags || [],
      Confidence: item.confidence,
      baselineProbabilities: item.model ? {
        home: item.model.home,
        draw: item.model.draw,
        away: item.model.away
      } : null,
      challengerProbabilities: item.shadow?.challenger?.probabilities || null,
      providerHealth: item.diagnostics?.providerHealth || null
    };
  }

  function appendOfficialValueSignals({ analysisId, analysedAt, items, modelVersion }) {
    const existing = new Set(readJsonl(officialSignalsFile).map(row => row.signalId));
    const issued = [];
    for (const item of items.filter(row => row.category === "value" && row.candidate)) {
      const snapshot = officialSignalFromItem({ analysisId, issuedAt: analysedAt, item, modelVersion });
      appendLifecycleEvent({
        eventId: eventId(snapshot.signalId, "DETECTED", analysisId),
        signalId: snapshot.signalId,
        fixtureId: snapshot.fixtureId,
        type: "DETECTED",
        at: analysedAt,
        category: item.category
      });
      if (existing.has(snapshot.signalId)) {
        appendLifecycleEvent({
          eventId: eventId(snapshot.signalId, "UPDATED", analysisId),
          signalId: snapshot.signalId,
          fixtureId: snapshot.fixtureId,
          type: "UPDATED",
          at: analysedAt,
          latestOdds: item.candidate.odds,
          latestCategory: item.category
        });
        continue;
      }
      appendJsonl(officialSignalsFile, snapshot);
      existing.add(snapshot.signalId);
      issued.push(snapshot);
      appendLifecycleEvent({
        eventId: eventId(snapshot.signalId, "ISSUED", snapshot.issuedAt),
        signalId: snapshot.signalId,
        fixtureId: snapshot.fixtureId,
        type: "ISSUED",
        at: snapshot.issuedAt,
        immutable: true
      });
    }

    for (const item of items.filter(row => row.category !== "value" && row.candidate)) {
      const id = signalId(item);
      if (existing.has(id)) {
        appendLifecycleEvent({
          eventId: eventId(id, "DOWNGRADED", analysisId),
          signalId: id,
          fixtureId: item.id,
          type: "DOWNGRADED",
          at: analysedAt,
          latestCategory: item.category
        });
      }
    }
    return issued;
  }

  function appendShadowSignals({ analysisId, analysedAt, items, revisionThreshold = 0.02 }) {
    const existing = readJsonl(shadowSignalsFile);
    const latestById = new Map();
    for (const row of existing) latestById.set(row.signalId, row);

    for (const item of items.filter(row => row.shadow)) {
      const shadow = item.shadow;
      if (shadow.shadowStatus !== "OK") continue;
      for (const selection of ["home", "draw", "away"]) {
        const side = selection === "home" ? "П1" : selection === "draw" ? "X" : "П2";
        const baselineCandidate = shadow.baseline.market.candidates.find(row => row.key === selection);
        const challengerCandidate = shadow.challenger.market.candidates.find(row => row.key === selection);
        const marketOdds = baselineCandidate?.odds ?? null;
        const id = shadowSignalId(item, selection);
        const previous = latestById.get(id);
        const baselineProbability = shadow.baseline.probabilities;
        const challengerProbability = shadow.challenger.probabilities;

        if (previous &&
          !oddsChanged(previous, marketOdds, revisionThreshold) &&
          !probabilityChanged(previous, baselineProbability, challengerProbability) &&
          previous.baselineCategory === item.category &&
          previous.challengerShadowCategory === shadow.challenger.shadowCategory) {
          continue;
        }

        appendJsonl(shadowSignalsFile, {
          signalId: id,
          revision: previous ? Number(previous.revision || 1) + 1 : 1,
          analysisId,
          fixtureId: item.id,
          kickoff: item.utcDate,
          competition: item.competition,
          market: "h2h",
          selection: side,
          marketOdds,
          marketSource: item.diagnostics?.market?.source || null,
          marketFreshness: item.diagnostics?.market?.freshness || null,
          marketObservedAt: item.diagnostics?.market?.observedAt || null,
          marketFallbackReason: item.diagnostics?.market?.fallbackReason || null,
          firstSeenOdds: previous?.firstSeenOdds ?? marketOdds,
          latestOdds: marketOdds,
          bestSeenOdds: bestSeenOdds(previous, marketOdds),
          oddsHistory: oddsHistory(previous, marketOdds, analysedAt),
          baselineProbability,
          challengerProbability,
          baselineSelectionProbability: baselineProbability[selection],
          challengerSelectionProbability: challengerProbability[selection],
          baselineFairOdds: baselineCandidate?.fairOdds ?? null,
          challengerFairOdds: challengerCandidate?.fairOdds ?? null,
          baselineEdge: baselineCandidate?.edge ?? null,
          challengerEdge: challengerCandidate?.edge ?? null,
          baselineEV: baselineCandidate?.ev ?? null,
          challengerEV: challengerCandidate?.ev ?? null,
          baselineCategory: item.category,
          challengerShadowCategory: shadow.challenger.shadowCategory,
          DQ: item.diagnostics?.dataQualityV2 ?? null,
          Risk: item.diagnostics?.risk ?? null,
          providerStatuses: item.diagnostics?.providerHealth ?? null,
          disagreementStatus: shadow.disagreementStatus,
          topPickAgreement: shadow.topPickAgreement,
          createdAt: analysedAt
        });
      }
    }
  }

  function readShadowSignals() {
    return readJsonl(shadowSignalsFile);
  }

  function readOfficialSignals() {
    return readJsonl(officialSignalsFile);
  }

  function readSettlements() {
    return readJsonl(settlementsFile);
  }

  function readSignalEvents() {
    return readJsonl(signalEventsFile);
  }

  function shadowStats() {
    return shadowSummary(readShadowSignals());
  }

  function appendShadowResultAudit({ fixtureId, actualResult, finishedAt = new Date().toISOString() }) {
    const records = readShadowSignals().filter(row => row.fixtureId === fixtureId);
    const latestBySelection = new Map();
    for (const row of records) latestBySelection.set(row.selection, row);
    const source = latestBySelection.values().next().value;
    const scored = scoreFinishedShadow(source, actualResult);
    if (!scored) return null;

    const audit = {
      ...source,
      ...scored,
      finishedAt,
      roi: null,
      roiReason: "CLV/ROI disabled until a real pre-match market signal and closing odds are captured."
    };
    appendJsonl(shadowResultsFile, audit);
    return audit;
  }

  function lockSignalsAtKickoff({ now = new Date().toISOString(), latestBySignalId = {} } = {}) {
    const existingEvents = new Set(readSignalEvents().map(row => row.eventId));
    const locked = [];
    for (const signal of readOfficialSignals()) {
      if (new Date(signal.kickoff).getTime() > new Date(now).getTime()) continue;
      const id = eventId(signal.signalId, "KICKOFF_LOCKED", signal.kickoff);
      if (existingEvents.has(id)) continue;
      const latest = latestBySignalId[signal.signalId] || {};
      const latestObservedAt = latest.marketObservedAt;
      const latestIsPreKickoff = latestObservedAt &&
        new Date(latestObservedAt).getTime() < new Date(signal.kickoff).getTime();
      const observedAt = latestIsPreKickoff ? latestObservedAt : signal.marketObservedAt;
      const event = {
        eventId: id,
        signalId: signal.signalId,
        fixtureId: signal.fixtureId,
        type: "KICKOFF_LOCKED",
        at: signal.kickoff,
        latestPreKickoffOdds: latestIsPreKickoff ? latest.latestOdds ?? signal.officialOdds : signal.officialOdds,
        bestSeenOdds: latestIsPreKickoff ? latest.bestSeenOdds ?? signal.officialOdds : signal.officialOdds,
        lastMarketObservation: observedAt,
        modelProbabilityLatest: latestIsPreKickoff ? latest.modelProbability ?? signal.modelProbability : signal.modelProbability,
        categoryLatest: latestIsPreKickoff ? latest.category ?? "value" : "value"
      };
      appendJsonl(signalEventsFile, event);
      locked.push(event);
    }
    return locked;
  }

  function settleOfficialSignal({ signalId: id, result, settledAt = new Date().toISOString(), marketQuotes = [], closingWindowMinutes = 30 }) {
    const signal = readOfficialSignals().find(row => row.signalId === id);
    if (!signal) return null;
    const existing = readSettlements().find(row => row.signalId === id);
    if (existing) return existing;

    const settlement = settleSignal(signal, result, 1);
    if (!settlement || settlement.status === "UNSUPPORTED") return null;
    const closing = findClosingQuote({ signal, marketQuotes, closingWindowMinutes });
    const clv = calculateClv({ signal, closing });
    const row = {
      ...settlement,
      settledAt,
      finishedAt: result.finishedAt || null,
      resultFetchedAt: result.resultFetchedAt || settledAt,
      clv
    };
    appendJsonl(settlementsFile, row);
    appendLifecycleEvent({
      eventId: eventId(id, "SETTLED", result.resultFetchedAt || settledAt),
      signalId: id,
      fixtureId: signal.fixtureId,
      type: "SETTLED",
      at: settledAt,
      status: row.status,
      netUnits: row.netUnits
    });
    return row;
  }

  function auditDaily(date) {
    return dailyAudit({
      date,
      signals: readOfficialSignals(),
      settlements: readSettlements(),
      shadowResults: readJsonl(shadowResultsFile)
    });
  }

  function auditCumulative() {
    return cumulativeStatistics({
      signals: readOfficialSignals(),
      settlements: readSettlements(),
      shadowResults: readJsonl(shadowResultsFile)
    });
  }

  return {
    appendAnalysis,
    appendSignals,
    appendShadowSignals,
    appendShadowResultAudit,
    appendOfficialValueSignals,
    appendLifecycleEvent,
    lockSignalsAtKickoff,
    settleOfficialSignal,
    readShadowSignals,
    readOfficialSignals,
    readSettlements,
    readSignalEvents,
    shadowStats,
    auditDaily,
    auditCumulative,
    analysesFile,
    signalsFile,
    officialSignalsFile,
    signalEventsFile,
    settlementsFile,
    shadowSignalsFile,
    shadowResultsFile
  };
}
