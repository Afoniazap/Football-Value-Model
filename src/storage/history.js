import fs from "node:fs";
import path from "node:path";

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

export function createHistoryStore(root) {
  const historyDir = path.join(root, "data", "history");
  const analysesFile = path.join(historyDir, "analyses.jsonl");
  const signalsFile = path.join(historyDir, "signals.jsonl");

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
        dataQuality: item.dataQuality
      });
    }
  }

  return { appendAnalysis, appendSignals, analysesFile, signalsFile };
}
