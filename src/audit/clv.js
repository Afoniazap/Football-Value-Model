import { removeMargin } from "../market/margin.js";

function selectionKey(selection) {
  const value = String(selection || "").toLowerCase();
  if (["п1", "p1", "home", "1"].includes(value)) return "home";
  if (["x", "draw"].includes(value)) return "draw";
  if (["п2", "p2", "away", "2"].includes(value)) return "away";
  return null;
}

export function findClosingQuote({ signal, marketQuotes, closingWindowMinutes = 30 }) {
  const kickoff = new Date(signal.kickoff).getTime();
  const candidates = (marketQuotes || [])
    .filter(row => row.fixtureId === signal.fixtureId)
    .filter(row => row.market === signal.market)
    .filter(row => row.selection === signal.selection)
    .filter(row => new Date(row.observedAt).getTime() < kickoff)
    .map(row => ({
      ...row,
      ageBeforeKickoffMinutes: (kickoff - new Date(row.observedAt).getTime()) / 60_000
    }))
    .sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt));

  const inWindow = candidates.find(row => row.ageBeforeKickoffMinutes <= closingWindowMinutes);
  return inWindow || null;
}

export function clvQuality(signal, closing) {
  if (!closing) return "N/A";
  if (closing.ageBeforeKickoffMinutes <= 30 && closing.source === signal.marketSource) return "HIGH";
  if (closing.ageBeforeKickoffMinutes <= 60) return "MEDIUM";
  return "LOW";
}

export function calculateClv({ signal, closing, allClosingOdds = null }) {
  if (!signal || !closing) {
    return {
      oddsClv: null,
      probabilityClv: null,
      quality: "N/A",
      reason: "No suitable closing odds"
    };
  }

  const oddsClv = (Number(closing.odds) / Number(signal.officialOdds)) - 1;
  const key = selectionKey(signal.selection);
  let probabilityClv = null;
  if (key && allClosingOdds?.home && allClosingOdds?.draw && allClosingOdds?.away) {
    const closingNoVig = removeMargin(allClosingOdds);
    probabilityClv = closingNoVig[key] - (1 / Number(signal.officialOdds));
  }

  return {
    issueOdds: signal.officialOdds,
    closingOdds: closing.odds,
    issueObservedAt: signal.marketObservedAt,
    closingObservedAt: closing.observedAt,
    closingAgeBeforeKickoffMinutes: closing.ageBeforeKickoffMinutes,
    oddsClv,
    probabilityClv,
    marketSource: closing.source,
    bookmakerConsistency: closing.bookmaker === signal.officialBookmaker,
    quality: clvQuality(signal, closing)
  };
}
