// Read-only reporting helpers -- never used by the fit itself. These exist
// purely to answer, honestly, what the unseen-team league-average fallback
// (model.js's teamCoefficients) actually touches, and to catch any
// NaN/Infinity/invalid probability that should be impossible post-fix.
import { buildScoreMatrix } from "./scoreMatrix.js";

function teamSeenSet(train) {
  const set = new Set();
  for (const m of train) { set.add(`${m.league}|${m.home}`); set.add(`${m.league}|${m.away}`); }
  return set;
}

function isUnseenTeamMatch(seen, m) {
  return !seen.has(`${m.league}|${m.home}`) || !seen.has(`${m.league}|${m.away}`);
}

export function unseenTeamStats(train, evalMatches) {
  const seen = teamSeenSet(train);
  const unseenNames = new Set();
  let withUnseen = 0;
  for (const m of evalMatches) {
    const homeKey = `${m.league}|${m.home}`, awayKey = `${m.league}|${m.away}`;
    let flagged = false;
    if (!seen.has(homeKey)) { unseenNames.add(homeKey); flagged = true; }
    if (!seen.has(awayKey)) { unseenNames.add(awayKey); flagged = true; }
    if (flagged) withUnseen++;
  }
  return { totalMatches: evalMatches.length, matchesWithUnseenTeam: withUnseen, unseenTeamCount: unseenNames.size, unseenTeamNames: [...unseenNames].sort() };
}

/** Splits evalMatches (and their 1:1 predictions) into unseen-team vs known-only subsets. */
export function splitByUnseenTeam(train, evalMatches, predictions) {
  const seen = teamSeenSet(train);
  const withUnseen = { matches: [], predictions: [] };
  const knownOnly = { matches: [], predictions: [] };
  evalMatches.forEach((m, i) => {
    const bucket = isUnseenTeamMatch(seen, m) ? withUnseen : knownOnly;
    bucket.matches.push(m);
    bucket.predictions.push(predictions[i]);
  });
  return { withUnseen, knownOnly };
}

export function validatePredictions(predictions) {
  let invalid = 0;
  const problems = [];
  predictions.forEach((p, i) => {
    const vals = [p.home, p.draw, p.away];
    const sum = p.home + p.draw + p.away;
    const bad = vals.some(v => !Number.isFinite(v) || v < -1e-9) || Math.abs(sum - 1) > 1e-6;
    if (bad) { invalid++; if (problems.length < 5) problems.push({ i, p, sum }); }
  });
  return { total: predictions.length, invalid, problems };
}

/** Rebuilds the DC score matrix for each (lambdaHome, lambdaAway) pair to check
 * truncation tail mass and cell validity -- independent of the 1X2-only path
 * the fit actually uses for prediction. */
export function matrixDiagnosticsFor(lambdaPairs, rho) {
  let maxTailMass = 0, invalidCount = 0;
  for (const { lambdaHome, lambdaAway } of lambdaPairs) {
    const { matrix, n, tailMass } = buildScoreMatrix(lambdaHome, lambdaAway, rho);
    if (tailMass > maxTailMass) maxTailMass = tailMass;
    let sum = 0, bad = false;
    for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) {
      const v = matrix[x][y];
      if (!Number.isFinite(v) || v < -1e-9) bad = true;
      sum += v;
    }
    if (bad || Math.abs(sum - 1) > 1e-6) invalidCount++;
  }
  return { maxTailMass, invalidCount, checked: lambdaPairs.length };
}
