import fs from "node:fs";
import path from "node:path";

const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "FINISHED"]);

function canonical(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|cf|afc|sc|ac|cd|fk|rc|ca|ud|de|club)\b/g, " ")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function finiteScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeHistoryMatch(match, provenance, fetchedAt = new Date().toISOString()) {
  const playedAt = match.playedAt || match.utcDate || match.fixture?.date || null;
  const home = match.homeTeam || match.teams?.home || {};
  const away = match.awayTeam || match.teams?.away || {};
  const homeGoals = finiteScore(match.score?.fullTime?.home ?? match.goals?.home);
  const awayGoals = finiteScore(match.score?.fullTime?.away ?? match.goals?.away);
  const source = String(provenance || match.provenance?.source || "UNKNOWN").toUpperCase();
  const sourceFixtureId = String(match.sourceFixtureId || match.id || match.fixture?.id || "");

  if (!sourceFixtureId || !playedAt || !home.name || !away.name || homeGoals === null || awayGoals === null) return null;

  return {
    schemaVersion: 1,
    recordKey: `${source}:${sourceFixtureId}`,
    sourceFixtureId,
    fixtureId: source === "API_FOOTBALL" ? sourceFixtureId : null,
    playedAt: new Date(playedAt).toISOString(),
    competition: {
      id: match.leagueId ?? match.competition?.id ?? match.league?.id ?? null,
      code: match.competitionCode ?? match.competition?.code ?? null,
      name: match.league ?? match.competition?.name ?? match.league?.name ?? null,
      country: match.country ?? match.area?.name ?? match.league?.country ?? null,
      season: match.season ?? match.seasonStart ?? match.league?.season ?? null
    },
    homeTeam: { id: home.id ?? null, name: home.name },
    awayTeam: { id: away.id ?? null, name: away.name },
    score: { fullTime: { home: homeGoals, away: awayGoals } },
    statistics: match.statistics ?? null,
    provenance: { source },
    fetchedAt: new Date(fetchedAt).toISOString()
  };
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function readLegacy(filePath) {
  try {
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function loadLocalHistory(filePath, legacyFilePath = null) {
  const rows = readJsonLines(filePath);
  const legacy = legacyFilePath
    ? readLegacy(legacyFilePath).map(row => normalizeHistoryMatch(row, "API_FOOTBALL", row.fetchedAt || row.utcDate)).filter(Boolean)
    : [];
  return [...new Map([...legacy, ...rows].map(row => [row.recordKey, row])).values()];
}

export function appendLocalHistory(filePath, matches, provenance, fetchedAt = new Date().toISOString()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const known = new Set(readJsonLines(filePath).map(row => row.recordKey));
  const added = [];

  for (const match of matches || []) {
    const row = normalizeHistoryMatch(match, provenance, fetchedAt);
    if (!row || known.has(row.recordKey)) continue;
    known.add(row.recordKey);
    added.push(row);
  }

  if (added.length) fs.appendFileSync(filePath, `${added.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return added.length;
}

function teamMatches(row, teamId, teamName, side) {
  const team = side === "HOME" ? row.homeTeam : row.awayTeam;
  if (row.provenance?.source === "API_FOOTBALL" && teamId != null && String(team.id) === String(teamId)) return true;
  return canonical(team.name) === canonical(teamName);
}

function usableBeforeKickoff(rows, fixture) {
  const kickoff = new Date(fixture.utcDate).getTime();
  return rows.filter(row => {
    const playedAt = new Date(row.playedAt).getTime();
    return Number.isFinite(playedAt) && playedAt < kickoff &&
      FINISHED_STATUSES.has(row.status || "FINISHED");
  });
}

function selectTeamHistory(rows, teamId, teamName, limit) {
  return rows
    .filter(row => teamMatches(row, teamId, teamName, "HOME") || teamMatches(row, teamId, teamName, "AWAY"))
    .sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt))
    .slice(0, limit);
}

function aggregateTeam(rows, fixtureTeam, mode = "TOTAL") {
  let playedGames = 0, won = 0, draw = 0, lost = 0, points = 0, goalsFor = 0, goalsAgainst = 0;
  for (const row of rows) {
    const home = teamMatches(row, fixtureTeam.id, fixtureTeam.name, "HOME");
    const away = teamMatches(row, fixtureTeam.id, fixtureTeam.name, "AWAY");
    if ((!home && !away) || (mode === "HOME" && !home) || (mode === "AWAY" && !away)) continue;
    const gf = home ? row.score.fullTime.home : row.score.fullTime.away;
    const ga = home ? row.score.fullTime.away : row.score.fullTime.home;
    playedGames++; goalsFor += gf; goalsAgainst += ga;
    if (gf > ga) { won++; points += 3; }
    else if (gf === ga) { draw++; points++; }
    else lost++;
  }
  if (!playedGames) return null;
  return { team: fixtureTeam, playedGames, won, draw, lost, points, goalsFor, goalsAgainst };
}

function rank(rows) {
  return rows.filter(Boolean)
    .sort((a, b) => b.points - a.points || (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst) || b.goalsFor - a.goalsFor)
    .map((row, index) => ({ ...row, position: index + 1 }));
}

export function buildLocalHistoryContext(history, fixture, limit = 20) {
  const safe = usableBeforeKickoff(history || [], fixture);
  const homeRows = selectTeamHistory(safe, fixture.homeId, fixture.home, limit);
  const awayRows = selectTeamHistory(safe, fixture.awayId, fixture.away, limit);
  const combined = [...new Map([...homeRows, ...awayRows].map(row => [row.recordKey, row])).values()];
  const homeTeam = { id: fixture.homeId, name: fixture.home };
  const awayTeam = { id: fixture.awayId, name: fixture.away };
  const total = rank([aggregateTeam(homeRows, homeTeam), aggregateTeam(awayRows, awayTeam)]);
  const home = rank([aggregateTeam(homeRows, homeTeam, "HOME"), aggregateTeam(awayRows, awayTeam, "HOME")]);
  const away = rank([aggregateTeam(homeRows, homeTeam, "AWAY"), aggregateTeam(awayRows, awayTeam, "AWAY")]);
  const groups = [{ type: "TOTAL", table: total }];
  if (home.length === 2 && away.length === 2) groups.push({ type: "HOME", table: home }, { type: "AWAY", table: away });

  return {
    source: "LOCAL_HISTORY",
    derivedFromFinishedMatches: true,
    standings: total.length === 2 && homeRows.length >= 4 && awayRows.length >= 4
      ? { standings: groups }
      : null,
    finished: combined.map(row => ({
      id: row.recordKey,
      utcDate: row.playedAt,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      score: row.score,
      provenance: row.provenance
    })),
    scheduled: [],
    contextMeta: {
      source: "LOCAL_HISTORY",
      provenance: [...new Set(combined.map(row => row.provenance?.source).filter(Boolean))],
      homeMatches: homeRows.length,
      awayMatches: awayRows.length,
      homeSources: [...new Set(homeRows.map(row => row.provenance?.source).filter(Boolean))],
      awaySources: [...new Set(awayRows.map(row => row.provenance?.source).filter(Boolean))],
      temporalSafe: true
    }
  };
}

export function mergeWithLocalHistory(context, history, fixture) {
  const local = buildLocalHistoryContext(history, fixture);
  const externalFinished = context?.finished || [];
  const matchKey = row => {
    const date = String(row.utcDate || row.playedAt || "").slice(0, 10);
    return `${date}|${canonical(row.homeTeam?.name)}|${canonical(row.awayTeam?.name)}`;
  };
  const finished = [...new Map([...(local.finished || []), ...externalFinished].map(row => [matchKey(row), row])).values()];
  return {
    ...(context || {}),
    standings: context?.standings || local.standings,
    finished,
    scheduled: context?.scheduled || [],
    localHistoryMeta: local.contextMeta
  };
}
