// Diagnostic CLI for the Shadow V3 forward-audit log. Read-only, no HTTP,
// no writes. Prints the same counters/metrics updateV3ShadowHistory returns,
// for the current data/statistics/v3-shadow.jsonl. Never surfaced in
// Telegram -- CLI/diagnostic only, per Phase 2 spec.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadV3ShadowStatistics } from "../src/shadow/v3History.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "data", "statistics", "v3-shadow.jsonl");
const stats = loadV3ShadowStatistics(file);

console.log(`Attempted: ${stats.attempted} | Predicted: ${stats.predicted} | Skipped: ${stats.skipped} | Failed: ${stats.failed}`);
console.log(`Pending: ${stats.pending} | Completed: ${stats.completed} | True-unseen fixtures: ${stats.trueUnseenFixtures} | Unsupported competitions: ${stats.unsupportedCompetitions}`);
console.log(`Promotion review floor: 300 completed (preferred 500+) -- currently ${stats.completed >= 300 ? "READY" : "OBSERVE"}`);
console.log("\nOverall (completed only, own denominator per model):");
for (const [label, key] of [["V3 Dixon-Coles", "v3"], ["Independent Poisson", "independentPoisson"], ["Production", "production"]]) {
  const s = stats[key];
  console.log(`  ${label}: n=${s.completed} logLoss=${s.logLoss?.toFixed(4) ?? "n/a"} brier=${s.brier?.toFixed(4) ?? "n/a"}`);
}
console.log("\nPer competition:");
for (const code of Object.keys(stats.byCompetition.v3)) {
  console.log(`  ${code}: V3 n=${stats.byCompetition.v3[code].completed} logLoss=${stats.byCompetition.v3[code].logLoss?.toFixed(4) ?? "n/a"} | Poisson logLoss=${stats.byCompetition.independentPoisson[code]?.logLoss?.toFixed(4) ?? "n/a"} | Production logLoss=${stats.byCompetition.production[code]?.logLoss?.toFixed(4) ?? "n/a"}`);
}
