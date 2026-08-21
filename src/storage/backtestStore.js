import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeRoot } from "./runtime.js";

export function createBacktestStore(root, { runtimeRoot = resolveRuntimeRoot(root) } = {}) {
  const backtestsDir = path.join(runtimeRoot, "backtests");
  const rawDir = path.join(backtestsDir, "raw");
  const reportsDir = path.join(backtestsDir, "reports");

  function saveBacktestReport(name, report) {
    fs.mkdirSync(reportsDir, { recursive: true });
    const safeName = name.replace(/[^a-z0-9_.-]/gi, "_");
    const file = path.join(reportsDir, `${safeName}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
    return file;
  }

  function rawCachePath(name) {
    const safeName = name.replace(/[^a-z0-9_.-]/gi, "_");
    return path.join(rawDir, `${safeName}.json`);
  }

  function readRawCache(name) {
    const file = rawCachePath(name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  function saveRawCache(name, payload) {
    fs.mkdirSync(rawDir, { recursive: true });
    const file = rawCachePath(name);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return file;
  }

  function saveTextReport(name, text) {
    fs.mkdirSync(reportsDir, { recursive: true });
    const safeName = name.replace(/[^a-z0-9_.-]/gi, "_");
    const file = path.join(reportsDir, `${safeName}.txt`);
    fs.writeFileSync(file, text, "utf8");
    return file;
  }

  return {
    backtestsDir,
    rawDir,
    reportsDir,
    saveBacktestReport,
    rawCachePath,
    readRawCache,
    saveRawCache,
    saveTextReport
  };
}
