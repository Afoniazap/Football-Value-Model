import crypto from "node:crypto";

// Frozen hyper-parameters of ratings-v1.1. Chosen by log-loss with scripts/ratings-v1-tune.js on matches played BEFORE
// 2026-08-01 only (grid in research/ratings-v1/README.md) and never re-fitted on the period they are evaluated on.
// `carry` is not tuned: with one season of data it is not identifiable for most leagues, so it is fixed a priori (0.8).
// A change of any value means a new model version (new PARAMS_ID), never an in-place edit.
export const RATINGS_V1_VERSION = "ratings-v1.1";

const tuned = (poisson, elo) => Object.freeze({
  poisson: Object.freeze({ ...poisson, etaLeague: 0.01, initialMu: Math.log(1.3), initialHomeAdvantage: 0.2 }),
  elo: Object.freeze({ ...elo, initial: 1500 }),
  maxGoals: 9,
  // results become usable this long after kickoff (match duration + provider delay)
  resultAvailableAfterMinutes: 180
});

export const RATINGS_V1_PARAMS = tuned(
  { eta: 0.035, warm: 2, reg: 0.004, carry: 0.8, rho: -0.1 },
  { K: 30, homeAdvantage: 90, drawWidth: 0.55, scale: 250, carry: 0.8 }
);

// Used ONLY for the retrospective check on January-June 2026 (tuned on matches before 2026-01-01, same procedure).
export const RATINGS_V1_PARAMS_TRAIN_A = tuned(
  { eta: 0.035, warm: 2, reg: 0.001, carry: 0.8, rho: -0.05 },
  { K: 30, homeAdvantage: 90, drawWidth: 0.55, scale: 250, carry: 0.8 }
);

// The first frozen set (ratings-v1.0), derived with a research prototype that wrongly shrank the ratings of ALL leagues at
// every league's season change. Kept only to report sensitivity; it is not used by the model.
export const RATINGS_V1_0_PARAMS_LEGACY = tuned(
  { eta: 0.035, warm: 2, reg: 0.001, carry: 0.85, rho: -0.1 },
  { K: 30, homeAdvantage: 70, drawWidth: 0.55, scale: 250, carry: 0.8 }
);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function paramsId(params = RATINGS_V1_PARAMS) {
  return `${RATINGS_V1_VERSION}:${crypto.createHash("sha256").update(JSON.stringify(stable(params))).digest("hex").slice(0, 12)}`;
}

export const RATINGS_V1_PARAMS_ID = paramsId(RATINGS_V1_PARAMS);
