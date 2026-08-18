function normalize(value) {
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

export function findOddsEvent(fixture, events) {
  return events.find(event =>
    kickoffCloseEnough(fixture.utcDate, event.commence_time) &&
    similarity(fixture.home, event.home_team) > 0.58 &&
    similarity(fixture.away, event.away_team) > 0.58
  );
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
