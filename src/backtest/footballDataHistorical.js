import "dotenv/config";
import { normalizeFinishedMatches } from "../historical/normalize.js";

export const DEFAULT_BACKTEST_COMPETITIONS = ["PL", "PD", "BL1", "SA", "FL1"];

export function previousCompletedEuropeanSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return String(month >= 7 ? year - 1 : year - 2);
}

function requestError(status, bodyText) {
  const error = new Error(`football-data historical request failed with HTTP ${status}`);
  error.status = status;
  error.bodyPreview = bodyText?.slice?.(0, 160) || "";
  return error;
}

export async function fetchCompetitionSeason({ token, competition, season }) {
  const url = new URL(`https://api.football-data.org/v4/competitions/${competition}/matches`);
  url.searchParams.set("season", season);
  url.searchParams.set("status", "FINISHED");

  const response = await fetch(url, {
    headers: { "X-Auth-Token": token }
  });

  const text = await response.text();
  if (!response.ok) {
    throw requestError(response.status, text);
  }

  return {
    fetchedAt: new Date().toISOString(),
    source: "football-data.org",
    endpoint: url.toString(),
    competition,
    season,
    data: JSON.parse(text)
  };
}

export async function loadHistoricalMatches({
  store,
  token = process.env.FOOTBALL_DATA_TOKEN,
  competitions = DEFAULT_BACKTEST_COMPETITIONS,
  season = previousCompletedEuropeanSeason(),
  useCache = true
} = {}) {
  if (!token) {
    throw new Error("FOOTBALL_DATA_TOKEN is required for real baseline backtest");
  }

  const rawResponses = [];
  const errors = [];
  for (const competition of competitions) {
    const cacheName = `${competition}-${season}-matches`;
    try {
      let raw = useCache ? store.readRawCache(cacheName) : null;
      if (!raw) {
        raw = await fetchCompetitionSeason({ token, competition, season });
        store.saveRawCache(cacheName, raw);
      }
      rawResponses.push(raw);
    } catch (error) {
      errors.push({
        competition,
        season,
        status: error.status || null,
        message: error.message
      });
    }
  }

  const matches = rawResponses.flatMap(raw =>
    normalizeFinishedMatches(raw.data?.matches || [], { season: raw.season })
  );

  return {
    competitions,
    seasons: [season],
    rawResponses,
    errors,
    matches
  };
}
