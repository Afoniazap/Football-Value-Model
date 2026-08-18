export function extremeProbabilityReport(predictions) {
  const extremeCases = predictions
    .filter(item => item.model)
    .map(item => {
      const probabilities = [
        { result: "H", key: "home", probability: item.model.home },
        { result: "D", key: "draw", probability: item.model.draw },
        { result: "A", key: "away", probability: item.model.away }
      ].sort((a, b) => b.probability - a.probability);
      return {
        ...item,
        topPrediction: probabilities[0]
      };
    })
    .filter(item => item.topPrediction.probability >= 0.8)
    .map(item => ({
      fixtureId: item.fixtureId,
      utcDate: item.utcDate,
      homeTeam: item.homeTeam,
      awayTeam: item.awayTeam,
      actualResult: item.actualResult,
      predictedResult: item.topPrediction.result,
      probability: item.topPrediction.probability,
      threshold: item.topPrediction.probability >= 0.9 ? ">=90" : ">=80",
      components: item.model.components,
      dataQuality: item.dataQuality,
      snapshotMeta: item.snapshotMeta
    }));

  const wrong = extremeCases
    .filter(item => item.predictedResult !== item.actualResult)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 20);

  const causes = {};
  for (const item of wrong) {
    const components = item.components || {};
    if (Math.abs((components.ppgH || 0) - (components.ppgA || 0)) > 1) {
      causes.largePpgGap = (causes.largePpgGap || 0) + 1;
    }
    if (Math.abs((components.gdH || 0) - (components.gdA || 0)) > 1) {
      causes.largeGoalDiffGap = (causes.largeGoalDiffGap || 0) + 1;
    }
    if (Math.abs((components.formH || 0) - (components.formA || 0)) > 1) {
      causes.largeRecentFormGap = (causes.largeRecentFormGap || 0) + 1;
    }
    if (item.actualResult === "D") {
      causes.drawMissed = (causes.drawMissed || 0) + 1;
    }
  }

  return {
    cases: extremeCases,
    topWrong: wrong,
    topWrongCauseCounts: causes
  };
}
