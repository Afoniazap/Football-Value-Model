// Primary metrics per spec: multiclass Log Loss and Brier. Accuracy is
// deliberately not computed anywhere in this module.
const OUTCOMES = ["home", "draw", "away"];
function actualOutcome(m) { return m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw"; }

export function logLoss(predictions, matches) {
  let sum = 0;
  for (let i = 0; i < matches.length; i++) {
    const p = Math.max(1e-12, predictions[i][actualOutcome(matches[i])]);
    sum -= Math.log(p);
  }
  return sum / matches.length;
}

export function brierScore(predictions, matches) {
  let sum = 0;
  for (let i = 0; i < matches.length; i++) {
    const actual = actualOutcome(matches[i]);
    for (const key of OUTCOMES) {
      const target = key === actual ? 1 : 0;
      const diff = predictions[i][key] - target;
      sum += diff * diff;
    }
  }
  return sum / matches.length;
}

/** 10 equal-width bins on the predicted probability of the outcome that
 * actually happened's own class -- reported per class (home/draw/away). */
export function calibrationBins(predictions, matches, bins = 10) {
  const table = OUTCOMES.map(() => Array.from({ length: bins }, () => ({ count: 0, predictedSum: 0, actualSum: 0 })));
  for (let i = 0; i < matches.length; i++) {
    const actual = actualOutcome(matches[i]);
    for (const [ci, key] of OUTCOMES.entries()) {
      const p = predictions[i][key];
      const bin = Math.min(bins - 1, Math.floor(p * bins));
      table[ci][bin].count++;
      table[ci][bin].predictedSum += p;
      table[ci][bin].actualSum += key === actual ? 1 : 0;
    }
  }
  return OUTCOMES.map((key, ci) => ({
    outcome: key,
    bins: table[ci].map((b, bi) => ({
      range: [bi / bins, (bi + 1) / bins],
      count: b.count,
      meanPredicted: b.count ? b.predictedSum / b.count : null,
      actualFrequency: b.count ? b.actualSum / b.count : null
    }))
  }));
}

export function breakdownByOutcome(predictions, matches) {
  const byActual = { home: [], draw: [], away: [] };
  for (let i = 0; i < matches.length; i++) byActual[actualOutcome(matches[i])].push(i);
  const result = {};
  for (const key of OUTCOMES) {
    const idx = byActual[key];
    result[key] = {
      count: idx.length,
      logLoss: idx.length ? logLoss(idx.map(i => predictions[i]), idx.map(i => matches[i])) : null,
      brier: idx.length ? brierScore(idx.map(i => predictions[i]), idx.map(i => matches[i])) : null
    };
  }
  return result;
}

export { actualOutcome };
