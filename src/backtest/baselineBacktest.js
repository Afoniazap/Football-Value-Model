import { buildModel } from "../model/probability.js";
import {
  createPreMatchContext,
  rejectionReason,
  toModelFixture
} from "../historical/featureSnapshot.js";
import { summarizeBacktest } from "./metrics.js";
import { calibrationReport } from "./calibration.js";
import { extremeProbabilityReport } from "./extremeAudit.js";
import { featureAudit } from "./featureAudit.js";

function teamHistoryCount(context, teamId) {
  return (context.matches || [])
    .filter(item => item.homeTeam?.id === teamId || item.awayTeam?.id === teamId)
    .length;
}

export function runBaselineBacktest(matches, options = {}) {
  const minimumPriorMatches = options.minimumPriorMatches ?? 5;
  const predictions = [];
  const rejected = [];

  const ordered = [...matches].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  for (const match of ordered) {
    const context = createPreMatchContext(match, ordered);
    const reason = rejectionReason(match, context, minimumPriorMatches);
    if (reason) {
      rejected.push({ fixtureId: match.fixtureId, reason });
      continue;
    }

    const modelFixture = toModelFixture(match);
    const modelled = buildModel(modelFixture, context);
    if (!modelled.model) {
      rejected.push({ fixtureId: match.fixtureId, reason: modelled.reason || "MODEL_UNAVAILABLE" });
      continue;
    }

    predictions.push({
      fixtureId: match.fixtureId,
      competition: match.competition,
      season: match.season,
      utcDate: match.utcDate,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      actualResult: match.result,
      model: modelled.model,
      dataQuality: modelled.dataQuality,
      snapshotMeta: {
        ...context.meta,
        teamHistory: {
          home: teamHistoryCount(context, match.homeTeamId),
          away: teamHistoryCount(context, match.awayTeamId)
        },
        teamHistoryMin: Math.min(
          teamHistoryCount(context, match.homeTeamId),
          teamHistoryCount(context, match.awayTeamId)
        )
      }
    });
  }

  return {
    coverage: {
      competitions: [...new Set(matches.map(match => match.competition).filter(Boolean))],
      competitionCodes: [...new Set(matches.map(match => match.competitionCode).filter(Boolean))],
      seasons: [...new Set(matches.map(match => match.season).filter(Boolean))],
      matchesAvailable: matches.length,
      matchesUsable: predictions.length,
      matchesRejected: rejected.length,
      rejectedReasons: rejected.reduce((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {})
    },
    predictions,
    rejected,
    metrics: summarizeBacktest(predictions),
    calibration: calibrationReport(predictions),
    extremeCases: extremeProbabilityReport(predictions),
    featureAudit: featureAudit(predictions)
  };
}
