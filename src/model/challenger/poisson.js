function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

export function poissonProbability(lambda, goals) {
  return (Math.exp(-lambda) * (lambda ** goals)) / factorial(goals);
}

export function scoreMatrix(lambdaHome, lambdaAway, maxGoals = 8) {
  const rows = [];
  let total = 0;
  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const probability = poissonProbability(lambdaHome, homeGoals) * poissonProbability(lambdaAway, awayGoals);
      rows.push({ homeGoals, awayGoals, probability });
      total += probability;
    }
  }
  return rows.map(row => ({ ...row, probability: row.probability / total }));
}

export function outcomeProbabilities(lambdaHome, lambdaAway, maxGoals = 8) {
  const matrix = scoreMatrix(lambdaHome, lambdaAway, maxGoals);
  const result = matrix.reduce((acc, row) => {
    if (row.homeGoals > row.awayGoals) acc.home += row.probability;
    else if (row.homeGoals === row.awayGoals) acc.draw += row.probability;
    else acc.away += row.probability;
    return acc;
  }, { home: 0, draw: 0, away: 0 });
  const total = result.home + result.draw + result.away;
  return {
    home: result.home / total,
    draw: result.draw / total,
    away: result.away / total,
    scoreMatrix: matrix
  };
}
