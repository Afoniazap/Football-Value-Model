// football-data.org v4: for matches decided after extra time or a penalty
// shoot-out, score.fullTime is the aggregate final score INCLUDING extra-time
// and shoot-out goals (docs example: fullTime 7-6, regularTime 1-1).
// 1X2 / totals / handicap markets and the 90-minute model use the
// regulation-time score, which v4 exposes as score.regularTime.
const NON_REGULATION_DURATIONS = new Set(["EXTRA_TIME", "PENALTY_SHOOTOUT"]);

function goalsPair(node) {
  if (!node || node.home === null || node.home === undefined || node.away === null || node.away === undefined) return null;
  const home = Number(node.home);
  const away = Number(node.away);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home, away };
}

// Returns { home, away, duration, basis } for the 90-minute score, or null when
// it cannot be determined (missing score, or extra-time match without
// regularTime). Never falls back to the extra-time/penalty aggregate.
export function regulationScore(match) {
  const score = match?.score || {};
  const duration = score.duration || "REGULAR";
  if (NON_REGULATION_DURATIONS.has(duration)) {
    const regular = goalsPair(score.regularTime);
    return regular ? { ...regular, duration, basis: "REGULAR_TIME" } : null;
  }
  const fullTime = goalsPair(score.fullTime);
  return fullTime ? { ...fullTime, duration, basis: "FULL_TIME" } : null;
}

// Rewrites score.fullTime to the regulation score so every downstream
// consumer (model features, Elo, form, splits) sees 90-minute goals. The
// provider's aggregate is preserved in score.fullTimeReported. Extra-time
// matches whose 90-minute score is unknown are dropped rather than guessed;
// regular-duration matches pass through unchanged.
export function toRegulationMatches(matches = []) {
  const kept = [];
  let adjusted = 0;
  let dropped = 0;
  for (const match of matches) {
    if (!NON_REGULATION_DURATIONS.has(match?.score?.duration)) {
      kept.push(match);
      continue;
    }
    const regulation = regulationScore(match);
    if (!regulation) {
      dropped += 1;
      continue;
    }
    adjusted += 1;
    kept.push({
      ...match,
      score: {
        ...match.score,
        fullTimeReported: match.score.fullTime,
        fullTime: { home: regulation.home, away: regulation.away }
      }
    });
  }
  return { matches: kept, adjusted, dropped };
}
