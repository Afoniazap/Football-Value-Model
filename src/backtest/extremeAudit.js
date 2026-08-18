export function extremeProbabilityReport(predictions) {
  return predictions
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
}
