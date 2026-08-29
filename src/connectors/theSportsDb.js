import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sameTeamIdentity, teamIdentityEvidence, teamSearchAliases } from "../history/teamAliases.js";

const BASE = "https://www.thesportsdb.com/api/v1/json/123";
let runtime = { cacheDir: null, fetchImpl: (...args) => fetch(...args), now: () => Date.now(), minGapMs: 2500 };
let lastRequestAt = 0;
let telemetry = { requests: 0, cacheHits: 0, unresolved: 0 };

export function configureTheSportsDb(options = {}) {
  runtime = { ...runtime, ...options };
  if (runtime.cacheDir) fs.mkdirSync(runtime.cacheDir, { recursive: true });
}

export function resetTheSportsDbTelemetry() { telemetry = { requests: 0, cacheHits: 0, unresolved: 0 }; }
export function getTheSportsDbTelemetry() { return { ...telemetry }; }

export function exactTeamMatch(query, candidates) {
  const evidence=teamIdentityEvidence(query);
  const matches = (candidates || []).filter(team => {
    if(!/^(soccer|football)$/i.test(String(team?.strSport||"")))return false;
    if(evidence?.source==="THESPORTSDB")return String(team.idTeam)===String(evidence.teamId);
    return sameTeamIdentity(query, team?.strTeam);
  });
  return matches.length === 1 ? matches[0] : null;
}

function cacheFile(url) {
  if (!runtime.cacheDir) return null;
  return path.join(runtime.cacheDir, `${crypto.createHash("sha256").update(url).digest("hex")}.json`);
}

async function getJson(url, ttlMs) {
  const file = cacheFile(url);
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (runtime.now() - Number(cached.fetchedAt) <= ttlMs) { telemetry.cacheHits++; return cached.data; }
  } catch {}
  const wait = Math.max(0, runtime.minGapMs - (runtime.now() - lastRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  const response = await runtime.fetchImpl(url);
  lastRequestAt = runtime.now(); telemetry.requests++;
  if (!response.ok) throw new Error(`TheSportsDB ${response.status}`);
  const data = await response.json();
  if (file) fs.writeFileSync(file, JSON.stringify({ fetchedAt: runtime.now(), data }), "utf8");
  return data;
}

function normalizeEvent(event) {
  if (!event?.idEvent || !event.strHomeTeam || !event.strAwayTeam) return null;
  if(event.strSport&&!/^(soccer|football)$/i.test(String(event.strSport)))return null;
  if (!/^(FT|Match Finished|Finished)$/i.test(String(event.strStatus || ""))) return null;
  const home = Number(event.intHomeScore), away = Number(event.intAwayScore);
  if (!Number.isFinite(home) || !Number.isFinite(away) || !event.dateEvent) return null;
  const playedAt = event.strTimestamp || `${event.dateEvent}T${event.strTime || "00:00:00"}Z`;
  return {
    id: String(event.idEvent), utcDate: playedAt,
    competition: { id: event.idLeague || null, name: event.strLeague || null },
    season: event.strSeason || null,
    homeTeam: { id: event.idHomeTeam || null, name: event.strHomeTeam },
    awayTeam: { id: event.idAwayTeam || null, name: event.strAwayTeam },
    score: { fullTime: { home, away } }
  };
}

export async function getFreeTeamPreviousEvents(teamName) {
  let team = null;
  for (const searchName of teamSearchAliases(teamName)) {
    const searchUrl = `${BASE}/searchteams.php?t=${encodeURIComponent(searchName)}`;
    const search = await getJson(searchUrl, 30 * 86400_000);
    team = exactTeamMatch(teamName, search?.teams);
    if (team) break;
  }
  if (!team?.idTeam) { telemetry.unresolved++; return { status: "UNRESOLVED", team: null, matches: [] }; }
  const eventsUrl = `${BASE}/eventslast.php?id=${encodeURIComponent(team.idTeam)}`;
  const events = await getJson(eventsUrl, 6 * 3600_000);
  return {
    status: "OK",
    team: { id: String(team.idTeam), apiFootballId:team.idAPIfootball?String(team.idAPIfootball):null, name: team.strTeam, leagueId:team.idLeague?String(team.idLeague):null, league:team.strLeague||null },
    currentSeason:events?.results?.[0]?.strSeason||null,
    matches: (events?.results || []).map(normalizeEvent).filter(Boolean)
  };
}

export async function getFreeLeagueRoundEvents(leagueId,season,round){
  if(!leagueId||!season||!Number.isInteger(Number(round)))return [];
  const url=`${BASE}/eventsround.php?id=${encodeURIComponent(leagueId)}&r=${encodeURIComponent(round)}&s=${encodeURIComponent(season)}`;
  const data=await getJson(url,30*86400_000);
  return (data?.events||[]).map(normalizeEvent).filter(Boolean);
}
