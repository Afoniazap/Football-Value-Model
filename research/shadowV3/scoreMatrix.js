// Builds the single DC score matrix a fixture's (lambdaHome, lambdaAway,
// rho) implies, truncated at the smallest N whose tail mass is provably
// below the target (see the readiness audit: a fixed N=10 leaves ~1.2e-3
// tail mass at realistic ceiling lambdas -- three orders of magnitude too
// loose). 1X2 is read off the matrix directly; OU/AH aggregation helpers are
// included (per spec) but never called from anywhere outside research/.
import { tau, logPoissonPmf } from "./model.js";

const MAX_N = 30; // hard safety ceiling so a pathological lambda can't spin forever

export function chooseN(lambdaHome, lambdaAway, targetTailMass = 1e-6) {
  for (let n = 4; n <= MAX_N; n++) {
    let cum = 0;
    for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) cum += Math.exp(logPoissonPmf(x, lambdaHome) + logPoissonPmf(y, lambdaAway));
    if (1 - cum < targetTailMass) return n;
  }
  return MAX_N;
}

/** Returns {matrix, n, tailMass, sum} where matrix[x][y] = P(home=x, away=y), normalized to sum 1. */
export function buildScoreMatrix(lambdaHome, lambdaAway, rho, targetTailMass = 1e-6) {
  const n = chooseN(lambdaHome, lambdaAway, targetTailMass);
  const matrix = [];
  let rawSum = 0;
  for (let x = 0; x <= n; x++) {
    const row = new Float64Array(n + 1);
    for (let y = 0; y <= n; y++) {
      const t = tau(x, y, lambdaHome, lambdaAway, rho);
      const p = Math.max(0, t) * Math.exp(logPoissonPmf(x, lambdaHome) + logPoissonPmf(y, lambdaAway));
      row[y] = p;
      rawSum += p;
    }
    matrix.push(row);
  }
  const tailMass = 1 - rawSum;
  // Explicit renormalization after truncation -- the tau correction itself
  // is exactly mass-preserving (proven algebraically in the audit), the
  // ONLY mass loss here is truncation at finite N.
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) matrix[x][y] /= rawSum;
  return { matrix, n, tailMass, sum: 1 };
}

export function aggregate1X2(matrix, n) {
  let home = 0, draw = 0, away = 0;
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) {
    if (x > y) home += matrix[x][y]; else if (x === y) draw += matrix[x][y]; else away += matrix[x][y];
  }
  return { home, draw, away };
}

// Prepared for future live-shadow use, NOT wired into any betting pipeline
// in Phase 1 (per spec: "не подключать их к betting pipeline").
export function aggregateOverUnder(matrix, n, line) {
  let over = 0, under = 0;
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) {
    const total = x + y;
    if (total > line) over += matrix[x][y]; else if (total < line) under += matrix[x][y];
  }
  const push = 1 - over - under;
  return { over, under, push };
}
export function aggregateAsianHandicap(matrix, n, homeLine) {
  let homeCovers = 0, awayCovers = 0;
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) {
    const margin = (x - y) + homeLine;
    if (margin > 0) homeCovers += matrix[x][y]; else if (margin < 0) awayCovers += matrix[x][y];
  }
  const push = 1 - homeCovers - awayCovers;
  return { home: homeCovers, away: awayCovers, push };
}
