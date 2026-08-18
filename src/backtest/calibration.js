function binForProbability(probability) {
  if (probability >= 1) return "90-100";
  const start = Math.floor(probability * 10) * 10;
  return `${start}-${start + 10}`;
}

function emptyBin(label) {
  return {
    bin: label,
    sampleSize: 0,
    predictedSum: 0,
    actualSum: 0,
    meanPredicted: null,
    actualFrequency: null
  };
}

export function calibrationBins(predictions, outcomeKey) {
  const labels = Array.from({ length: 10 }, (_, index) => `${index * 10}-${index * 10 + 10}`);
  const bins = new Map(labels.map(label => [label, emptyBin(label)]));
  const actualResult = outcomeKey === "home" ? "H" : outcomeKey === "draw" ? "D" : "A";

  for (const prediction of predictions.filter(item => item.model)) {
    const probability = prediction.model[outcomeKey];
    const bin = bins.get(binForProbability(probability));
    bin.sampleSize += 1;
    bin.predictedSum += probability;
    bin.actualSum += prediction.actualResult === actualResult ? 1 : 0;
  }

  return [...bins.values()].map(bin => ({
    bin: bin.bin,
    sampleSize: bin.sampleSize,
    meanPredicted: bin.sampleSize ? bin.predictedSum / bin.sampleSize : null,
    actualFrequency: bin.sampleSize ? bin.actualSum / bin.sampleSize : null
  }));
}

export function calibrationReport(predictions) {
  return {
    home: calibrationBins(predictions, "home"),
    draw: calibrationBins(predictions, "draw"),
    away: calibrationBins(predictions, "away")
  };
}
