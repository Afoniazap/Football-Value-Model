import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeRoot } from "../../storage/runtime.js";
const SELECTIONS = [
  { key: "home", side: "П1" },
  { key: "draw", side: "X" },
  { key: "away", side: "П2" }
];

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function freshnessStatus(observedAt, now, config) {
  const ageMinutes = (new Date(now).getTime() - new Date(observedAt).getTime()) / 60_000;
  if (!Number.isFinite(ageMinutes)) return { status: "EXPIRED", ageMinutes: null };
  if (ageMinutes <= config.oddsFreshMinutes) return { status: "FRESH", ageMinutes };
  if (ageMinutes <= config.oddsStaleMinutes) return { status: "STALE", ageMinutes };
  return { status: "EXPIRED", ageMinutes };
}

function quoteId(row) {
  return `${row.fixtureId}:h2h:${row.selection}:${row.bookmaker}:${row.line}`;
}

function latestByQuote(rows) {
  const latest = new Map();
  for (const row of rows) latest.set(row.quoteId || quoteId(row), row);
  return latest;
}

export function createMarketCache(root, { runtimeRoot = resolveRuntimeRoot(root) } = {}) {
  const marketDir = path.join(runtimeRoot, "market");
  const quotesFile = path.join(marketDir, "odds-history.jsonl");

  function readQuotes() {
    return readJsonl(quotesFile);
  }

  function appendFixtureOdds({ fixture, oddsEvent, source, observedAt, matchingConfidence, revisionThreshold }) {
    const existing = latestByQuote(readQuotes());
    const rows = [];

    for (const book of oddsEvent?.bookmakers || []) {
      const market = book.markets?.find(item => item.key === "h2h");
      if (!market) continue;
      const values = {};
      for (const outcome of market.outcomes || []) values[outcome.name] = outcome.price;

      for (const selection of SELECTIONS) {
        const name = selection.key === "home" ? oddsEvent.home_team : selection.key === "away" ? oddsEvent.away_team : "Draw";
        const odds = values[name];
        if (!odds) continue;
        const row = {
          fixtureId: fixture.id,
          kickoff: fixture.utcDate,
          market: "h2h",
          selection: selection.side,
          selectionKey: selection.key,
          line: "1X2",
          bookmaker: book.title,
          odds,
          source,
          observedAt,
          matchingConfidence
        };
        row.quoteId = quoteId(row);
        const previous = existing.get(row.quoteId);
        if (previous && Math.abs(Number(previous.odds) - Number(odds)) < revisionThreshold) continue;
        rows.push({
          ...row,
          revision: previous ? Number(previous.revision || 1) + 1 : 1,
          firstSeenOdds: previous?.firstSeenOdds ?? odds,
          latestOdds: odds,
          bestSeenOdds: previous ? Math.max(Number(previous.bestSeenOdds || odds), odds) : odds
        });
      }
    }

    for (const row of rows) appendJsonl(quotesFile, row);
    return rows;
  }

  function cachedEventForFixture(fixture, now, config) {
    const rows = readQuotes()
      .filter(row => row.fixtureId === fixture.id && row.market === "h2h")
      .sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
    const latest = latestByQuote(rows);
    const usable = [...latest.values()]
      .map(row => ({ ...row, freshness: freshnessStatus(row.observedAt, now, config) }))
      .filter(row => row.freshness.status !== "EXPIRED");
    if (!usable.length) return null;

    const byBook = new Map();
    for (const row of usable) {
      if (!byBook.has(row.bookmaker)) byBook.set(row.bookmaker, []);
      byBook.get(row.bookmaker).push({
        name: row.selectionKey === "home" ? fixture.home : row.selectionKey === "away" ? fixture.away : "Draw",
        price: row.odds
      });
    }

    const worstFreshness = usable.some(row => row.freshness.status === "STALE") ? "STALE" : "FRESH";
    return {
      id: `cache-${fixture.id}`,
      home_team: fixture.home,
      away_team: fixture.away,
      commence_time: fixture.utcDate,
      marketMeta: {
        source: "market.cache",
        freshness: worstFreshness,
        observedAt: usable.reduce((latest, row) =>
          new Date(row.observedAt) > new Date(latest) ? row.observedAt : latest,
        usable[0].observedAt)
      },
      bookmakers: [...byBook.entries()].map(([title, outcomes]) => ({
        title,
        markets: [{ key: "h2h", outcomes }]
      }))
    };
  }

  function summary(now, config) {
    const latest = [...latestByQuote(readQuotes()).values()];
    const counts = { FRESH: 0, STALE: 0, EXPIRED: 0 };
    const byFixture = new Map();
    for (const row of latest) {
      const status = freshnessStatus(row.observedAt, now, config).status;
      const current = byFixture.get(row.fixtureId);
      if (!current || current === "EXPIRED" || (current === "STALE" && status === "FRESH")) {
        byFixture.set(row.fixtureId, status);
      }
    }
    for (const status of byFixture.values()) counts[status] += 1;
    return {
      fixturesCached: byFixture.size,
      fresh: counts.FRESH,
      stale: counts.STALE,
      expired: counts.EXPIRED
    };
  }

  return {
    marketDir,
    quotesFile,
    readQuotes,
    appendFixtureOdds,
    cachedEventForFixture,
    summary
  };
}
