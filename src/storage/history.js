import fs from "node:fs";
import path from "node:path";
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

function oddsRevisionChanged(previous, item) {
  if (!previous?.candidate || !item.candidate) return true;
  return Math.abs(Number(previous.candidate.odds) - Number(item.candidate.odds)) >= 0.01;
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

function oddsChanged(previous, marketOdds) {
  if (!previous) return true;
  if (previous.marketOdds === null && marketOdds === null) return false;
  if (previous.marketOdds === null || marketOdds === null) return true;
  return Math.abs(Number(previous.marketOdds) - Number(marketOdds)) >= 0.01;
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
  const shadowSignalsFile = path.join(historyDir, "shadow-signals.jsonl");
  const shadowResultsFile = path.join(historyDir, "shadow-results.jsonl");

  function appendAnalysis(snapshot) {
    appendJsonl(analysesFile, snapshot);
  }

  function appendSignals({ analysisId, analysedAt, items }) {
    const existing = readJsonl(signalsFile);
    const latestById = new Map();
    for (const row of existing) latestById.set(row.signalId, row);

    for (const item of items.filter(x => ["value", "near"].includes(x.category))) {
      if (!item.candidate) continue;
      const id = signalId(item);
      const previous = latestById.get(id);
      if (previous && !oddsRevisionChanged(previous, item)) continue;

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

  function appendShadowSignals({ analysisId, analysedAt, items }) {
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
          !oddsChanged(previous, marketOdds) &&
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

  return {
    appendAnalysis,
    appendSignals,
    appendShadowSignals,
    appendShadowResultAudit,
    readShadowSignals,
    shadowStats,
    analysesFile,
    signalsFile,
    shadowSignalsFile,
    shadowResultsFile
  };
}
