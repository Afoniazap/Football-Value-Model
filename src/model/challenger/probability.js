import { eloDiagnostic } from "./elo.js";
import { formLambdaFactors } from "./formAdjustment.js";
import { outcomeProbabilities } from "./poisson.js";
import { expectedGoalsFromContext } from "./teamStrength.js";

export const CHALLENGER_MODEL_V1 = "CHALLENGER_MODEL_V1";

export const CHALLENGER_VARIANTS = {
  POISSON: { key: "POISSON", useElo: false, useForm: false },
  POISSON_ELO: { key: "POISSON+ELO", useElo: true, useForm: false },
  POISSON_FORM: { key: "POISSON+FORM", useElo: false, useForm: true },
  POISSON_ELO_FORM: { key: "POISSON+ELO+FORM", useElo: true, useForm: true }
};

function softmax(values) {
  const max = Math.max(...values);
  const exp = values.map(value => Math.exp(value - max));
  const sum = exp.reduce((acc, value) => acc + value, 0);
  return exp.map(value => value / sum);
}

function logitAdjust(probabilities, elo) {
  const effect = Math.max(-0.18, Math.min(0.18, (elo.expectedHome - 0.5) * 0.5));
  const eps = 1e-12;
  const logits = [
    Math.log(Math.max(eps, probabilities.home)) + effect,
    Math.log(Math.max(eps, probabilities.draw)) - Math.abs(effect) * 0.25,
    Math.log(Math.max(eps, probabilities.away)) - effect
  ];
  const [home, draw, away] = softmax(logits);
  return { home, draw, away, eloEffect: effect };
}

export function buildChallengerModel(fixture, context, variant = CHALLENGER_VARIANTS.POISSON) {
  const baseExpected = expectedGoalsFromContext(context, fixture);
  let lambdaHome = baseExpected.lambdaHome;
  let lambdaAway = baseExpected.lambdaAway;
  let form = null;

  if (variant.useForm) {
    form = formLambdaFactors(context, fixture);
    lambdaHome *= form.homeFactor;
    lambdaAway *= form.awayFactor;
  }

  const poisson = outcomeProbabilities(lambdaHome, lambdaAway);
  let probabilities = {
    home: poisson.home,
    draw: poisson.draw,
    away: poisson.away
  };
  let elo = null;
  let eloEffect = null;

  if (variant.useElo) {
    elo = eloDiagnostic(context, fixture);
    const adjusted = logitAdjust(probabilities, elo);
    probabilities = {
      home: adjusted.home,
      draw: adjusted.draw,
      away: adjusted.away
    };
    eloEffect = adjusted.eloEffect;
  }

  return {
    ...fixture,
    modelVersion: CHALLENGER_MODEL_V1,
    variant: variant.key,
    model: {
      ...probabilities,
      expectedGoals: lambdaHome + lambdaAway,
      components: {
        lambdaHome,
        lambdaAway,
        leagueHomeGoalsPerGame: baseExpected.league.homeGoalsPerGame,
        leagueAwayGoalsPerGame: baseExpected.league.awayGoalsPerGame,
        shrinkageGames: baseExpected.components.shrinkageGames,
        homeAttack: baseExpected.components.homeAttack,
        awayDefense: baseExpected.components.awayDefense,
        awayAttack: baseExpected.components.awayAttack,
        homeDefense: baseExpected.components.homeDefense,
        eloHomeRating: elo?.homeRating ?? null,
        eloAwayRating: elo?.awayRating ?? null,
        eloExpectedHome: elo?.expectedHome ?? null,
        eloEffect,
        formEffect: form?.effect ?? null
      },
      scoreMatrix: poisson.scoreMatrix
    }
  };
}
