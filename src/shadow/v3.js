// Live Shadow V3 orchestration -- observer only, never touches Production's
// VALUE/NEAR/WAIT/NO_BET, Confidence/FDS, gates, or betting output. Reuses
// the Phase 1 offline-research math UNCHANGED (research/shadowV3/*.js) --
// this file adds only what live integration needs: a reusable training
// snapshot (never refit per fixture), competition-scope gating, unseen-team
// bookkeeping, and defensive validation so a V3 failure can never throw out
// of predictV3/getV3Snapshot into the caller's refresh cycle.
import { loadV3Dataset, beforeCutoff, V3_LEAGUES } from "../../research/shadowV3/dataset.js";
import { decayWeight } from "../../research/shadowV3/decay.js";
import { buildParamIndex, initParams, teamKey } from "../../research/shadowV3/params.js";
import { matchLambdas } from "../../research/shadowV3/model.js";
import { fitRho } from "../../research/shadowV3/rho.js";
import { buildScoreMatrix, aggregate1X2 } from "../../research/shadowV3/scoreMatrix.js";
import { canonicalTeamIdentity } from "../history/teamAliases.js";

export { V3_LEAGUES };
export const V3_MODEL_VERSION = "v3-dixon-coles-phase2-v1";
// Frozen Phase 1 hyperparameters -- NOT re-tuned here, never re-tuned against
// live/untouched data. rho is the only parameter fit at runtime, and only on
// training data strictly before the snapshot's own trainedThrough cutoff.
export const V3_FROZEN_PARAMS = { halfLife: 365, priorVariance: 0.25 };
const TAIL_MASS_TOLERANCE = 1e-6; // same target used throughout Phase 1

// A snapshot is reused across every fixture that needs one within this
// window, rather than refit per fixture -- refit cost is a few seconds
// (gradient descent over ~100-400 params), not worth paying per fixture in
// the same refresh tick. 30 minutes matches the app's own default refresh
// cadence (REFRESH_MINUTES), so in practice each refresh tick gets exactly
// one fit, reused by every eligible fixture in that tick.
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
let cachedSnapshot = null;

/**
 * Builds (or reuses) the shared training snapshot. Three distinct
 * timestamps, not one collapsed into "trainedThrough":
 *  - snapshotCreatedAt: when this fit ran (wall clock at fit time).
 *  - trainingCutoff: the strict upper bound passed to beforeCutoff() --
 *    the boundary PARAMETER, not necessarily an actual match time.
 *  - trainedThrough: the actual max kickoff among the matches that passed
 *    that filter -- the real forensic answer to "what's the latest result
 *    this model has seen". Can be meaningfully earlier than trainingCutoff
 *    (e.g. a quiet day with no finished matches right before the fit).
 * predictV3's leakage guard compares against trainedThrough (the tighter,
 * more conservative of the two -- trainedThrough < trainingCutoff always,
 * by construction, since every training match satisfies kickoffMs <
 * trainingCutoff), so reusing a cached snapshot across many fixtures/ticks
 * within the TTL window can never leak a future result into training: each
 * prediction re-checks trainedThrough against ITS OWN fixture's kickoff,
 * never trusting the cache silently.
 */
export function getV3Snapshot(dbPath, nowMs = Date.now()) {
  if (cachedSnapshot && nowMs - cachedSnapshot.builtAtMs < SNAPSHOT_TTL_MS) return cachedSnapshot;
  try {
    const matches = beforeCutoff(loadV3Dataset(dbPath), nowMs);
    if (!matches.length) throw new Error("no training matches before cutoff");
    let trainedThrough = -Infinity;
    for (const m of matches) if (m.kickoffMs > trainedThrough) trainedThrough = m.kickoffMs;
    const index = buildParamIndex(matches);
    const weights = matches.map(m => decayWeight(m.kickoffMs, nowMs, V3_FROZEN_PARAMS.halfLife));
    const rhoResult = fitRho(initParams(index), index, matches, weights, V3_FROZEN_PARAMS.priorVariance);
    cachedSnapshot = {
      converged: rhoResult.converged,
      reason: rhoResult.reason,
      snapshotCreatedAt: nowMs,
      trainingCutoff: nowMs,
      trainedThrough,
      trainingMatchCount: matches.length,
      index: rhoResult.converged ? index : null,
      params: rhoResult.converged ? rhoResult.fit.params : null,
      rho: rhoResult.converged ? rhoResult.rho : null,
      builtAtMs: nowMs
    };
  } catch (e) {
    cachedSnapshot = { converged: false, reason: e.message, snapshotCreatedAt: nowMs, trainingCutoff: nowMs, trainedThrough: nowMs, trainingMatchCount: 0, builtAtMs: nowMs };
  }
  return cachedSnapshot;
}

/** Test-only: forces the next getV3Snapshot call to rebuild. */
export function resetV3SnapshotCache() { cachedSnapshot = null; }

function validProbability(p) {
  return p && ["home", "draw", "away"].every(k => Number.isFinite(p[k]) && p[k] >= 0)
    && Math.abs(p.home + p.draw + p.away - 1) < 1e-6;
}

/**
 * Predicts one fixture against an existing snapshot. NEVER throws -- every
 * failure mode (unsupported competition, non-convergent snapshot, leakage
 * guard, non-finite lambda, invalid probabilities, excess tail mass) returns
 * a {status:"SKIPPED"|"FAILED", reason} object instead, so a caller can log
 * it and move on without any risk to the surrounding refresh cycle.
 */
export function predictV3(fixture, snapshot) {
  try {
    if (!V3_LEAGUES.includes(fixture.competitionCode)) {
      return { status: "SKIPPED", reason: "UNSUPPORTED_COMPETITION" };
    }
    if (!snapshot?.converged) {
      return { status: "FAILED", reason: snapshot?.reason || "no V3 snapshot available" };
    }
    const kickoffMs = new Date(fixture.utcDate || fixture.kickoff).getTime();
    if (!(snapshot.trainedThrough < kickoffMs)) {
      return { status: "FAILED", reason: "leakage guard: snapshot.trainedThrough is not strictly before this fixture's kickoff" };
    }
    const homeIdentity = canonicalTeamIdentity(fixture.home);
    const awayIdentity = canonicalTeamIdentity(fixture.away);
    const unseenHome = !snapshot.index.teamIndex.has(teamKey(fixture.competitionCode, homeIdentity));
    const unseenAway = !snapshot.index.teamIndex.has(teamKey(fixture.competitionCode, awayIdentity));
    const { lambdaHome, lambdaAway } = matchLambdas(snapshot.params, snapshot.index, { league: fixture.competitionCode, home: homeIdentity, away: awayIdentity });
    if (!(lambdaHome > 0) || !(lambdaAway > 0)) {
      return { status: "FAILED", reason: `non-positive or non-finite lambda (${lambdaHome}, ${lambdaAway})` };
    }
    const dc = buildScoreMatrix(lambdaHome, lambdaAway, snapshot.rho, TAIL_MASS_TOLERANCE);
    const poisson = buildScoreMatrix(lambdaHome, lambdaAway, 0, TAIL_MASS_TOLERANCE);
    const probability = aggregate1X2(dc.matrix, dc.n);
    const independentPoissonProbability = aggregate1X2(poisson.matrix, poisson.n);
    if (!validProbability(probability) || !validProbability(independentPoissonProbability)) {
      return { status: "FAILED", reason: "probabilities not finite/non-negative/summing to 1" };
    }
    if (dc.tailMass >= TAIL_MASS_TOLERANCE || poisson.tailMass >= TAIL_MASS_TOLERANCE) {
      return { status: "FAILED", reason: `score-matrix tail mass over tolerance (dc=${dc.tailMass}, poisson=${poisson.tailMass})` };
    }
    return {
      status: "PREDICTED",
      modelVersion: V3_MODEL_VERSION,
      snapshotCreatedAt: snapshot.snapshotCreatedAt,
      trainingCutoff: snapshot.trainingCutoff,
      trainedThrough: snapshot.trainedThrough,
      trainingMatchCount: snapshot.trainingMatchCount,
      halfLife: V3_FROZEN_PARAMS.halfLife,
      priorVariance: V3_FROZEN_PARAMS.priorVariance,
      rho: snapshot.rho,
      lambdaHome, lambdaAway,
      probability, independentPoissonProbability,
      tailMass: dc.tailMass, matrixN: dc.n,
      unseenHome, unseenAway,
      homeIdentity, awayIdentity
    };
  } catch (e) {
    return { status: "FAILED", reason: e.message };
  }
}
