import fs from "node:fs";
import path from "node:path";

export function createBacktestStore(root) {
  const backtestsDir = path.join(root, "data", "backtests");

  function saveBacktestReport(name, report) {
    fs.mkdirSync(backtestsDir, { recursive: true });
    const safeName = name.replace(/[^a-z0-9_.-]/gi, "_");
    const file = path.join(backtestsDir, `${safeName}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
    return file;
  }

  return { backtestsDir, saveBacktestReport };
}
