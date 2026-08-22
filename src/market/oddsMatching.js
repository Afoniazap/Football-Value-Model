import { normalizeClubName } from "../context/fixtureMatching.js";

function normalize(value) {
  const shared = normalizeClubName(value);
  if (shared) return shared.replaceAll(" ", "");
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9а-яё]/gi, "")
    .replace(/fc|cf|afc|club|calcio|football/g, "");
}

function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const chars = new Set(x);
  let common = 0;
  for (const c of y) if (chars.has(c)) common++;
  return common / Math.max(x.length, y.length, 1);
}

function kickoffCloseEnough(fixtureUtcDate, eventCommenceTime) {
  if (!eventCommenceTime) return true;
  const fixtureTime = new Date(fixtureUtcDate).getTime();
  const eventTime = new Date(eventCommenceTime).getTime();
  if (!Number.isFinite(fixtureTime) || !Number.isFinite(eventTime)) return false;
  return Math.abs(fixtureTime - eventTime) <= 3 * 3600_000;
}

function kickoffConfidence(fixtureUtcDate, eventCommenceTime) {
  if (!eventCommenceTime) return 0.7;
  const fixtureTime = new Date(fixtureUtcDate).getTime();
  const eventTime = new Date(eventCommenceTime).getTime();
  if (!Number.isFinite(fixtureTime) || !Number.isFinite(eventTime)) return 0;
  const diffHours = Math.abs(fixtureTime - eventTime) / 3600_000;
  if (diffHours > 3) return 0;
  return Math.max(0, 1 - diffHours / 3);
}

function eventConfidence(fixture, event) {
  const home = similarity(fixture.home, event.home_team);
  const away = similarity(fixture.away, event.away_team);
  const kickoff = kickoffConfidence(fixture.utcDate, event.commence_time);
  const competition = !event.sport_key || !fixture.sportKey || event.sport_key === fixture.sportKey ? 1 : 0.65;
  return Number(((home * 0.35) + (away * 0.35) + (kickoff * 0.2) + (competition * 0.1)).toFixed(4));
}

export function matchOddsEvent(fixture, events, minConfidence = 0.7) {
  const candidates = (events || [])
    .filter(event => kickoffCloseEnough(fixture.utcDate, event.commence_time))
    .map(event => ({ event, confidence: eventConfidence(fixture, event) }))
    .sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || null;
  if (!best || best.confidence < minConfidence) {
    return {
      event: null,
      confidence: best?.confidence || 0,
      diagnostic: best ? "MATCH_LOW_CONFIDENCE" : "MATCH_NOT_FOUND"
    };
  }
  return { ...best, diagnostic: null };
}

export function findOddsEvent(fixture, events) {
  return matchOddsEvent(fixture, events).event;
}

export function bestH2H(event) {
  if (!event) return null;
  let best = null;

  for (const book of event.bookmakers || []) {
    const market = book.markets?.find(m => m.key === "h2h");
    if (!market) continue;

    const values = {};
    for (const outcome of market.outcomes || []) {
      values[outcome.name] = outcome.price;
    }

    const row = {
      bookmaker: book.title,
      home: values[event.home_team],
      draw: values.Draw,
      away: values[event.away_team]
    };

    if (!row.home || !row.draw || !row.away) continue;
    const score = row.home + row.draw + row.away;
    const bestScore = best ? best.home + best.draw + best.away : 0;
    // TODO: bestH2H later -> market consensus.
    if (!best || score > bestScore) best = row;
  }
  return best;
}
