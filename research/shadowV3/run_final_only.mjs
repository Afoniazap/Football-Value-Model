// Frozen-hyperparameter evaluation runner: re-runs ONLY the untouched
// 2026/27 final test, never the tuning grid search (folds A/B). Distinct
// from run.js, which always re-tunes from scratch (~10-15 min) -- this is
// the fast (~1 min) path for re-checking final-test performance after a
// change to the underlying data or identity layer, without ever letting
// the untouched test influence hyperparameter selection. halfLife/
// priorVariance below are the Phase 1 frozen values (chosen on folds A/B
// before any identity-layer work) and must be updated by hand, deliberately,
// if tuning is ever legitimately redone -- never inferred from this file.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadV3Dataset, V3_LEAGUES } from "./dataset.js";
import { buildFolds, runFinalTest } from "./walkforward.js";
import { unseenTeamStats, splitByUnseenTeam, validatePredictions, matrixDiagnosticsFor } from "./diagnostics.js";
import { logLoss, brierScore } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "data", "history", "football.sqlite");
const CHOSEN = { halfLife: 365, priorVariance: 0.25 }; // frozen from the prior tuning run, not re-derived here

function fmt(n, d = 4) { return Number.isFinite(n) ? n.toFixed(d) : String(n); }
function reportSubset(label, subset) {
  if (subset.matches.length === 0) { console.log(`  ${label}: 0 matches`); return; }
  console.log(`  ${label}: n=${subset.matches.length} logLoss=${fmt(logLoss(subset.predictions, subset.matches))} brier=${fmt(brierScore(subset.predictions, subset.matches))}`);
}

function main() {
  console.log("=== Shadow V3 Phase 1: UNTOUCHED FINAL TEST RE-RUN (post identity-layer fix) ===");
  console.log(`Leagues: ${V3_LEAGUES.join(", ")}`);
  console.log(`Frozen hyperparameters (NOT re-tuned): halfLife=${CHOSEN.halfLife}, priorVariance=${CHOSEN.priorVariance}\n`);

  const matches = loadV3Dataset(DB_PATH);
  console.log(`Total eligible matches: ${matches.length}`);
  const folds = buildFolds(matches);
  console.log(`Final: ${folds.finalTest.label} -- train ${folds.finalTest.train.length}, test ${folds.finalTest.validation.length}\n`);

  const unseenFinal = unseenTeamStats(folds.finalTest.train, folds.finalTest.validation);
  console.log(`Unseen-team audit (final test, AFTER identity fix): ${unseenFinal.matchesWithUnseenTeam}/${unseenFinal.totalMatches} matches, ${unseenFinal.unseenTeamCount} distinct identities: ${unseenFinal.unseenTeamNames.join(", ")}\n`);

  const final = runFinalTest(folds, CHOSEN);
  console.log(`Test matches: ${final.testMatches}`);
  console.log(`Fitted rho: ${fmt(final.rho, 4)} (feasible range [${fmt(final.dcFit.rhoFeasibleRange.lower, 4)}, ${fmt(final.dcFit.rhoFeasibleRange.upper, 4)}])`);
  console.log(`Convergence: DC iterations=${final.dcFit.iterations} finalGradNorm=${fmt(final.dcFit.finalGradNorm, 6)} reason="${final.dcFit.reason}"`);
  console.log(`Convergence: Poisson iterations=${final.poissonFit.iterations} finalGradNorm=${fmt(final.poissonFit.finalGradNorm, 6)} reason="${final.poissonFit.reason}"`);

  const dcMatrixDiag = matrixDiagnosticsFor(final.dcLambdaPairs, final.rho);
  const poissonMatrixDiag = matrixDiagnosticsFor(final.poissonLambdaPairs, 0);
  console.log(`Score-matrix checks: DC maxTailMass=${dcMatrixDiag.maxTailMass.toExponential(3)} invalid=${dcMatrixDiag.invalidCount}; Poisson maxTailMass=${poissonMatrixDiag.maxTailMass.toExponential(3)} invalid=${poissonMatrixDiag.invalidCount}`);
  for (const [label, preds] of [["Naive", final.naivePredictions], ["Independent Poisson", final.poissonPredictions], ["V3 Dixon-Coles", final.dcPredictions]]) {
    const v = validatePredictions(preds);
    console.log(`Prediction validity: ${label}: ${v.invalid}/${v.total} invalid`);
  }

  console.log("\nModel                | LogLoss  | Brier");
  console.log("----------------------|----------|--------");
  console.log(`Naive (league freq)   | ${fmt(final.naive.logLoss)} | ${fmt(final.naive.brier)}`);
  console.log(`Independent Poisson   | ${fmt(final.independentPoisson.logLoss)} | ${fmt(final.independentPoisson.brier)}`);
  console.log(`V3 Dixon-Coles        | ${fmt(final.dixonColes.logLoss)} | ${fmt(final.dixonColes.brier)}`);

  console.log("\nH/D/A breakdown (V3 Dixon-Coles):");
  for (const [outcome, s] of Object.entries(final.dixonColes.breakdown)) console.log(`  ${outcome}: n=${s.count} logLoss=${fmt(s.logLoss)} brier=${fmt(s.brier)}`);
  console.log("H/D/A breakdown (Independent Poisson):");
  for (const [outcome, s] of Object.entries(final.independentPoisson.breakdown)) console.log(`  ${outcome}: n=${s.count} logLoss=${fmt(s.logLoss)} brier=${fmt(s.brier)}`);

  console.log("\n=== True unseen/promoted vs historically-known teams (untouched test set) ===");
  const dcSplit = splitByUnseenTeam(final.train, final.test, final.dcPredictions);
  const poissonSplit = splitByUnseenTeam(final.train, final.test, final.poissonPredictions);
  console.log("V3 Dixon-Coles:");
  reportSubset("True unseen/promoted", dcSplit.withUnseen);
  reportSubset("Historically known teams", dcSplit.knownOnly);
  console.log("Independent Poisson:");
  reportSubset("True unseen/promoted", poissonSplit.withUnseen);
  reportSubset("Historically known teams", poissonSplit.knownOnly);

  const beatsLogLoss = final.dixonColes.logLoss < final.independentPoisson.logLoss;
  const beatsBrier = final.dixonColes.brier < final.independentPoisson.brier;
  console.log(`\nV3 beats independent Poisson on untouched LogLoss: ${beatsLogLoss ? "YES" : "NO"}`);
  console.log(`V3 beats independent Poisson on untouched Brier: ${beatsBrier ? "YES" : "NO"}`);
  console.log("\n=== Done. Nothing written to git, src/ (beyond the reviewed identity-layer diff), or the SQLite file. ===");
}

main();
