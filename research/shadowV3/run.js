// Shadow V3 Phase 1 -- top-level offline experiment runner.
// READ-ONLY against the production SQLite file. Writes nothing to it,
// touches nothing under src/. Run with: node research/shadowV3/run.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadV3Dataset, datasetDiagnostics, V3_LEAGUES } from "./dataset.js";
import { buildFolds, tuneHyperparameters, runFinalTest } from "./walkforward.js";
import { unseenTeamStats, splitByUnseenTeam, validatePredictions, matrixDiagnosticsFor } from "./diagnostics.js";
import { logLoss, brierScore } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "data", "history", "football.sqlite");

function fmt(n, d = 4) { return Number.isFinite(n) ? n.toFixed(d) : String(n); }

function reportSubset(label, subset) {
  if (subset.matches.length === 0) { console.log(`  ${label}: 0 matches`); return; }
  console.log(`  ${label}: n=${subset.matches.length} logLoss=${fmt(logLoss(subset.predictions, subset.matches))} brier=${fmt(brierScore(subset.predictions, subset.matches))}`);
}

function main() {
  console.log("=== Shadow V3 Phase 1: offline research prototype ===");
  console.log(`Leagues: ${V3_LEAGUES.join(", ")}`);
  console.log(`DB (read-only): ${DB_PATH}\n`);

  const matches = loadV3Dataset(DB_PATH);
  console.log(`Total eligible matches: ${matches.length}\n`);
  console.log("Per league/season:");
  for (const d of datasetDiagnostics(matches)) {
    console.log(`  ${d.league} ${d.season ?? "(no season field)"}: ${d.matches} matches, ${d.teams} teams, ${d.minKickoff} .. ${d.maxKickoff}`);
  }

  const folds = buildFolds(matches);
  console.log(`\nFold A: ${folds.tuningA.label} -- train ${folds.tuningA.train.length}, validate ${folds.tuningA.validation.length}`);
  console.log(`Fold B: ${folds.tuningB.label} -- train ${folds.tuningB.train.length}, validate ${folds.tuningB.validation.length}`);
  console.log(`Final:  ${folds.finalTest.label} -- train ${folds.finalTest.train.length}, test ${folds.finalTest.validation.length}`);

  if (folds.tuningA.train.length === 0 || folds.tuningA.validation.length === 0 || folds.tuningB.validation.length === 0 || folds.finalTest.validation.length === 0) {
    console.error("\nABORT: one or more folds is empty -- cannot run walk-forward protocol as specified.");
    process.exitCode = 1;
    return;
  }

  console.log("\n=== Unseen-team audit (promotion/relegation across the fold boundary) ===");
  const unseenA = unseenTeamStats(folds.tuningA.train, folds.tuningA.validation);
  const unseenB = unseenTeamStats(folds.tuningB.train, folds.tuningB.validation);
  const unseenFinal = unseenTeamStats(folds.finalTest.train, folds.finalTest.validation);
  for (const [label, u] of [["Fold A validation", unseenA], ["Fold B validation", unseenB], ["Final test (2026/27)", unseenFinal]]) {
    console.log(`  ${label}: ${u.matchesWithUnseenTeam}/${u.totalMatches} matches involve a team unseen in training (${u.unseenTeamCount} distinct teams): ${u.unseenTeamNames.join(", ") || "(none)"}`);
  }

  console.log("\n=== Tuning (folds A + B only -- 2026/27 not touched) ===");
  const tuning = tuneHyperparameters(folds);
  console.log(`Hyperparameter grid: halfLife x priorVariance, ${tuning.grid.length} combos`);
  const nonFinite = tuning.grid.filter(e => !Number.isFinite(e.score));
  console.log(`All ${tuning.grid.length} combos finite/converged on both folds: ${nonFinite.length === 0 ? "YES" : `NO (${nonFinite.length} failed)`}`);
  console.log("\nFull grid (sorted by mean tuning logLoss):");
  console.log("halfLife | priorVariance | meanLogLoss | foldA logLoss (rho, iters) | foldB logLoss (rho, iters)");
  for (const e of [...tuning.grid].sort((a, b) => a.score - b.score)) {
    console.log(`  ${e.halfLife} | ${e.priorVariance} | ${fmt(e.score)} | ${fmt(e.foldA.logLoss)} (rho=${fmt(e.foldA.rho, 4)}, it=${e.foldA.iterations}) | ${fmt(e.foldB.logLoss)} (rho=${fmt(e.foldB.rho, 4)}, it=${e.foldB.iterations})`);
  }
  console.log(`\nSelection criterion: argmin over the grid of mean(foldA.logLoss, foldB.logLoss); a combo where either fold fails to converge scores +Infinity and is never selected.`);
  console.log(`CHOSEN (frozen before final test): halfLife=${tuning.chosen.halfLife}, priorVariance=${tuning.chosen.priorVariance}`);

  console.log("\n=== Untouched final test: 2026/27 (run once) ===");
  const final = runFinalTest(folds, tuning.chosen);
  console.log(`Test matches: ${final.testMatches}`);
  console.log(`Fitted rho (train-only MLE, profile-likelihood grid of ${final.dcFit.rhoGridPoints} points over feasible range [${fmt(final.dcFit.rhoFeasibleRange.lower, 4)}, ${fmt(final.dcFit.rhoFeasibleRange.upper, 4)}]): ${fmt(final.rho, 4)}`);

  console.log("\nConvergence diagnostics (final untouched-test fits):");
  console.log(`  V3 Dixon-Coles:      iterations=${final.dcFit.iterations}, finalGradNorm=${fmt(final.dcFit.finalGradNorm, 6)}, reason="${final.dcFit.reason}"`);
  console.log(`  Independent Poisson: iterations=${final.poissonFit.iterations}, finalGradNorm=${fmt(final.poissonFit.finalGradNorm, 6)}, reason="${final.poissonFit.reason}"`);

  console.log("\nScore-matrix invariant checks (rebuilt per test fixture, independent of the 1X2 path):");
  const dcMatrixDiag = matrixDiagnosticsFor(final.dcLambdaPairs, final.rho);
  const poissonMatrixDiag = matrixDiagnosticsFor(final.poissonLambdaPairs, 0);
  console.log(`  V3 Dixon-Coles:      checked=${dcMatrixDiag.checked}, maxTailMass=${dcMatrixDiag.maxTailMass.toExponential(3)}, invalidMatrices=${dcMatrixDiag.invalidCount}`);
  console.log(`  Independent Poisson: checked=${poissonMatrixDiag.checked}, maxTailMass=${poissonMatrixDiag.maxTailMass.toExponential(3)}, invalidMatrices=${poissonMatrixDiag.invalidCount}`);

  console.log("\nPrediction validity (probabilities finite, >=0, sum to 1 +/- 1e-6):");
  for (const [label, preds] of [["Naive", final.naivePredictions], ["Independent Poisson", final.poissonPredictions], ["V3 Dixon-Coles", final.dcPredictions]]) {
    const v = validatePredictions(preds);
    console.log(`  ${label}: ${v.invalid}/${v.total} invalid`);
  }

  console.log("\nModel                | LogLoss  | Brier");
  console.log("----------------------|----------|--------");
  console.log(`Naive (league freq)   | ${fmt(final.naive.logLoss)} | ${fmt(final.naive.brier)}`);
  console.log(`Independent Poisson   | ${fmt(final.independentPoisson.logLoss)} | ${fmt(final.independentPoisson.brier)}`);
  console.log(`V3 Dixon-Coles        | ${fmt(final.dixonColes.logLoss)} | ${fmt(final.dixonColes.brier)}`);

  console.log("\nH/D/A breakdown (V3 Dixon-Coles):");
  for (const [outcome, s] of Object.entries(final.dixonColes.breakdown)) {
    console.log(`  ${outcome}: n=${s.count} logLoss=${fmt(s.logLoss)} brier=${fmt(s.brier)}`);
  }
  console.log("H/D/A breakdown (Independent Poisson):");
  for (const [outcome, s] of Object.entries(final.independentPoisson.breakdown)) {
    console.log(`  ${outcome}: n=${s.count} logLoss=${fmt(s.logLoss)} brier=${fmt(s.brier)}`);
  }

  console.log("\nCalibration (V3 Dixon-Coles, 10 bins per outcome class):");
  for (const cls of final.dixonColes.calibration) {
    console.log(`  ${cls.outcome}:`);
    for (const b of cls.bins) if (b.count > 0) console.log(`    [${b.range[0].toFixed(1)}-${b.range[1].toFixed(1)}) n=${b.count} meanPredicted=${fmt(b.meanPredicted)} actualFrequency=${fmt(b.actualFrequency)}`);
  }

  console.log("\n=== Unseen-team fallback: does it mask a real problem? (matches WITH vs WITHOUT an unseen team, untouched test set) ===");
  const dcSplit = splitByUnseenTeam(final.train, final.test, final.dcPredictions);
  const poissonSplit = splitByUnseenTeam(final.train, final.test, final.poissonPredictions);
  console.log("V3 Dixon-Coles:");
  reportSubset("WITH unseen team (league-average fallback used)", dcSplit.withUnseen);
  reportSubset("WITHOUT unseen team (both teams seen in training)", dcSplit.knownOnly);
  console.log("Independent Poisson:");
  reportSubset("WITH unseen team (league-average fallback used)", poissonSplit.withUnseen);
  reportSubset("WITHOUT unseen team (both teams seen in training)", poissonSplit.knownOnly);

  const beatsLogLoss = final.dixonColes.logLoss < final.independentPoisson.logLoss;
  const beatsBrier = final.dixonColes.brier < final.independentPoisson.brier;
  console.log(`\nV3 beats independent Poisson on untouched LogLoss: ${beatsLogLoss ? "YES" : "NO"}`);
  console.log(`V3 beats independent Poisson on untouched Brier: ${beatsBrier ? "YES" : "NO"}`);
  console.log("V3 ready for live Shadow integration: NO (Phase 1 is an offline prototype only, per spec -- not wired to Telegram/VALUE/live Shadow)");

  console.log("\n=== Done. Nothing written to git, src/, or the SQLite file. ===");
}

main();
