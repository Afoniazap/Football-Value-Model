import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeRoot } from "../storage/runtime.js";

function readJsonlWithErrors(file) {
  if (!fs.existsSync(file)) return { rows: [], issues: [] };
  const issues = [];
  const rows = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(item => item.line.trim())
    .map(item => {
      try {
        return JSON.parse(item.line);
      } catch (error) {
        issues.push({
          file,
          line: item.lineNumber,
          code: "INVALID_JSONL",
          message: error.message
        });
        return null;
      }
    })
    .filter(Boolean);
  return { rows, issues };
}

function duplicates(rows, keyFn, code, file) {
  const seen = new Set();
  const issues = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (seen.has(key)) issues.push({ file, code, id: key, message: `Duplicate ${key}` });
    seen.add(key);
  }
  return issues;
}

function invalidTimestampIssues(rows, fields, file) {
  const issues = [];
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field];
      if (value && !Number.isFinite(new Date(value).getTime())) {
        issues.push({ file, code: "INVALID_TIMESTAMP", id: row.signalId || row.fixtureId || row.analysisId || null, field, value });
      }
    }
  }
  return issues;
}

export function runDoctor(root, { runtimeRoot = resolveRuntimeRoot(root) } = {}) {
  const files = {
    analyses: path.join(runtimeRoot, "history", "analyses.jsonl"),
    officialSignals: path.join(runtimeRoot, "history", "official-signals.jsonl"),
    signalEvents: path.join(runtimeRoot, "history", "signal-events.jsonl"),
    settlements: path.join(runtimeRoot, "history", "settlements.jsonl"),
    shadowSignals: path.join(runtimeRoot, "history", "shadow-signals.jsonl"),
    marketQuotes: path.join(runtimeRoot, "market", "odds-history.jsonl"),
    refreshHistory: path.join(runtimeRoot, "diagnostics", "refresh-history.jsonl")
  };
  const loaded = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, { file, ...readJsonlWithErrors(file) }]));
  const issues = Object.values(loaded).flatMap(item => item.issues);

  issues.push(...duplicates(loaded.officialSignals.rows, row => row.signalId, "DUPLICATE_OFFICIAL_SIGNAL", files.officialSignals));
  issues.push(...duplicates(loaded.signalEvents.rows, row => row.eventId, "DUPLICATE_EVENT_ID", files.signalEvents));
  issues.push(...duplicates(loaded.settlements.rows, row => row.signalId, "DUPLICATE_SETTLEMENT", files.settlements));

  for (const item of Object.values(loaded)) {
    issues.push(...invalidTimestampIssues(item.rows, ["analysedAt", "issuedAt", "kickoff", "utcDate", "observedAt", "settledAt", "finishedAt", "startedAt"], item.file));
  }

  const signals = new Set(loaded.officialSignals.rows.map(row => row.signalId));
  for (const settlement of loaded.settlements.rows) {
    if (!signals.has(settlement.signalId)) {
      issues.push({ file: files.settlements, code: "SETTLEMENT_WITHOUT_SIGNAL", id: settlement.signalId, message: "Settlement has no official signal" });
    }
  }

  for (const quote of loaded.marketQuotes.rows) {
    if (quote.kickoff && quote.observedAt && new Date(quote.observedAt).getTime() >= new Date(quote.kickoff).getTime()) {
      issues.push({ file: files.marketQuotes, code: "POST_KICKOFF_MARKET", id: quote.quoteId || quote.fixtureId, message: "Market quote observed at or after kickoff" });
    }
    for (const field of ["fixtureId", "market", "selection", "bookmaker", "odds", "source", "observedAt"]) {
      if (quote[field] === undefined || quote[field] === null || quote[field] === "") {
        issues.push({ file: files.marketQuotes, code: "MISSING_REQUIRED_FIELD", id: quote.quoteId || quote.fixtureId, field });
      }
    }
  }

  return {
    status: issues.length ? "FAIL" : "OK",
    checkedFiles: files,
    counts: Object.fromEntries(Object.entries(loaded).map(([key, item]) => [key, item.rows.length])),
    issues
  };
}
