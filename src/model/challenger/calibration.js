import { logLoss } from "../../backtest/metrics.js";

function renormalize(model) {
  const total = model.home + model.draw + model.away;
  return {
    home: model.home / total,
    draw: model.draw / total,
    away: model.away / total
  };
}

export function applyTemperature(model, temperature) {
  const eps = 1e-12;
  const adjusted = {
    home: Math.exp(Math.log(Math.max(eps, model.home)) / temperature),
    draw: Math.exp(Math.log(Math.max(eps, model.draw)) / temperature),
    away: Math.exp(Math.log(Math.max(eps, model.away)) / temperature)
  };
  return renormalize(adjusted);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function fitTemperature(predictions) {
  const candidates = [];
  for (let value = 0.75; value <= 1.8 + 1e-12; value += 0.025) {
    candidates.push(Number(value.toFixed(3)));
  }

  return candidates
    .map(temperature => ({
      temperature,
      logLoss: average(predictions.map(item => logLoss(applyTemperature(item.model, temperature), item.actualResult)))
    }))
    .sort((a, b) => a.logLoss - b.logLoss)[0];
}

export function calibratedPredictions(predictions, temperature) {
  return predictions.map(item => ({
    ...item,
    rawModel: item.model,
    model: {
      ...item.model,
      ...applyTemperature(item.model, temperature)
    },
    calibration: {
      method: "temperature",
      temperature
    }
  }));
}
