import { providerResult, SourceStatus } from "./providerResult.js";
import { normalizeClubName } from "../context/fixtureMatching.js";
import { stripHtml } from "../context/articleParser.js";

export const FlashscoreOutcome = Object.freeze({
  OK: "OK", PARTIAL: "PARTIAL", BLOCKED: "BLOCKED", UNSUPPORTED: "UNSUPPORTED",
  PARSE_ERROR: "PARSE_ERROR", HTTP_ERROR: "HTTP_ERROR", TIMEOUT: "TIMEOUT"
});

const BASE_URL = "https://www.flashscore.mobi";
const COMPETITION_ALIASES = Object.freeze({
  PL: "premier league", PD: "laliga", BL1: "bundesliga", SA: "serie a",
  FL1: "ligue 1", DED: "eredivisie", PPL: "liga portugal",
  CL: "champions league", EL: "europa league", CLI: "copa libertadores"
});
const STAT_LABELS = [
  "Expected goals (xG)", "xG on target (xGOT)", "Ball possession", "Total shots",
  "Shots on target", "Shots off target", "Blocked shots", "Big chances", "Corner kicks",
  "Fouls", "Offsides", "Yellow cards", "Red cards", "Passes"
];

function normalizedScore(value) {
  const match = String(value || "").replace(/&nbsp;/g, " ").match(/(\d+)\s*-\s*(\d+)/);
  return match ? { home: Number(match[1]), away: Number(match[2]) } : null;
}

function competitionParts(value) {
  const withoutNavigation = String(value || "").replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "");
  const [country, ...competition] = stripHtml(withoutNavigation).split(":");
  return { country: competition.length ? country.trim() : null, competition: (competition.length ? competition.join(":") : country).trim() };
}

export function parseFlashscoreIndex(html) {
  const body = String(html || "").match(/<div[^>]+id=["']score-data["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const headings = [...body.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi)];
  const fixtures = [];
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const section = body.slice(start, end);
    const competition = competitionParts(headings[index][1]);
    const rowPattern = /<span(?:\s+class=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/span>\s*([^<]+?)\s*<a[^>]+href=["']\/match\/([A-Za-z0-9]+)\/["'][^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const row of section.matchAll(rowPattern)) {
      const teams = stripHtml(row[3]).split(/\s+-\s+/);
      if (teams.length !== 2) continue;
      fixtures.push({
        externalId: row[4], home: teams[0], away: teams[1],
        country: competition.country, competition: competition.competition,
        kickoffDisplay: stripHtml(row[2]) || null,
        status: row[5].includes("fin") ? "FINISHED" : row[5].includes("live") || row[1]?.includes("live") ? "LIVE" : "SCHEDULED",
        score: normalizedScore(row[6]), detailUrl: `${BASE_URL}/match/${row[4]}/`
      });
    }
  }
  return fixtures;
}

function nameScore(left, right) {
  const a = normalizeClubName(left); const b = normalizeClubName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  return 0;
}

export function matchFlashscoreFixture(fixture, candidates = [], { minConfidence = 0.9 } = {}) {
  const expectedCompetition = COMPETITION_ALIASES[fixture.competitionCode] || normalizeClubName(fixture.competitionName);
  const ranked = candidates.filter(candidate => {
    if (!expectedCompetition) return true;
    return normalizeClubName(candidate.competition).includes(normalizeClubName(expectedCompetition));
  }).map(candidate => {
    const home = nameScore(fixture.home, candidate.home);
    const away = nameScore(fixture.away, candidate.away);
    const reversedHome = nameScore(fixture.home, candidate.away);
    const reversedAway = nameScore(fixture.away, candidate.home);
    const direct = (home + away) / 2;
    const reversed = (reversedHome + reversedAway) / 2;
    return { candidate, confidence: Math.max(direct, reversed), orientation: direct >= reversed ? "DIRECT" : "REVERSED" };
  }).filter(row => row.confidence >= minConfidence && row.orientation === "DIRECT")
    .sort((a, b) => b.confidence - a.confidence);
  if (!ranked.length || (ranked[1] && ranked[0].confidence === ranked[1].confidence)) return null;
  return ranked[0];
}

function matchDate(text) {
  const value = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\b/);
  return value ? { display: value[0], date: `${value[3]}-${value[2]}-${value[1]}`, time: `${value[4]}:${value[5]}`, timezone: null } : null;
}

function scalar(value) {
  const clean = String(value).trim();
  if (/^-?\d+(?:\.\d+)?%$/.test(clean)) return Number(clean.slice(0, -1));
  if (/^-?\d+(?:\.\d+)?$/.test(clean)) return Number(clean);
  return clean || null;
}

export function parseFlashscoreStats(html) {
  const text = stripHtml(html);
  const stats = {};
  for (const label of STAT_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`([0-9.]+%?(?: \\([^)]*\\))?)\\s+${escaped}\\s+([0-9.]+%?(?: \\([^)]*\\))?)`, "i"));
    if (match) stats[label] = { home: scalar(match[1]), away: scalar(match[2]) };
  }
  return stats;
}

export function parseFlashscoreRecent(html) {
  const text = stripHtml(html);
  const matches = [];
  const pattern = /(\d{2}\.\d{2}\.\d{4})\s+([\p{L}0-9 .'-]{2,45})\s+-\s+([\p{L}0-9 .'-]{2,45})\s+(\d+)\s*-\s*(\d+)/gu;
  for (const row of text.matchAll(pattern)) matches.push({ date: row[1], home: row[2].trim(), away: row[3].trim(), score: { home: Number(row[4]), away: Number(row[5]) } });
  return matches;
}

export function parseFlashscoreDetail({ summaryHtml, lineupHtml = "", statsHtml = "", h2hHtml = "", matched }) {
  const summary = stripHtml(summaryHtml);
  const kickoff = matchDate(summary);
  const score = normalizedScore(summary.match(new RegExp(`${matched.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+\\s*-\\s*\\d+)`, "i"))?.[1]);
  const lineupText = stripHtml(lineupHtml);
  const lineupsAvailable = Boolean(lineupText && /Clicking on a player/i.test(lineupText));
  return {
    externalId: matched.externalId, source: "FLASHSCORE", url: matched.detailUrl,
    home: matched.home, away: matched.away, competition: matched.competition,
    kickoff, status: matched.status, score: score || matched.score,
    lineups: lineupsAvailable ? { published: true, rawRosterText: lineupText.slice(0, 6_000), startingXI: null, substitutes: null } : null,
    absences: null, injuries: null, suspensions: null,
    statistics: parseFlashscoreStats(statsHtml), recentMatches: parseFlashscoreRecent(h2hHtml),
    h2h: parseFlashscoreRecent(h2hHtml), standings: null, playerStatistics: null
  };
}

function classifiedError(error) {
  if (error?.name === "AbortError" || /timeout|aborted/i.test(error?.message || "")) return FlashscoreOutcome.TIMEOUT;
  if ([401, 403, 429].includes(error?.status)) return FlashscoreOutcome.BLOCKED;
  if (error?.status) return FlashscoreOutcome.HTTP_ERROR;
  return FlashscoreOutcome.PARSE_ERROR;
}

export function compareFlashscoreFacts({ fixture, primary = {}, flashscore }) {
  if (!flashscore) return [];
  const comparisons = [];
  if (fixture.utcDate && flashscore.kickoff) comparisons.push({ field: "kickoff", primarySource: "FOOTBALL_DATA", primary: fixture.utcDate, flashscore: flashscore.kickoff.display, agreement: null, reason: "FLASHSCORE_TIMEZONE_UNAVAILABLE" });
  if (primary.score && flashscore.score) comparisons.push({ field: "score", primarySource: primary.scoreSource || "PRIMARY", primary: primary.score, flashscore: flashscore.score, agreement: Number(primary.score.home) === Number(flashscore.score.home) && Number(primary.score.away) === Number(flashscore.score.away) });
  if (primary.lineups && flashscore.lineups?.startingXI) comparisons.push({ field: "lineup", primarySource: primary.lineupSource || "API_FOOTBALL", primary: primary.lineups, flashscore: flashscore.lineups.startingXI, agreement: JSON.stringify(primary.lineups) === JSON.stringify(flashscore.lineups.startingXI) });
  return comparisons;
}

export async function fetchFlashscoreVerification({
  fixtures = [], httpClient, cache, now = new Date(), enabled = true,
  indexTtlMinutes = 15, detailTtlMinutes = 30
}) {
  if (!enabled) return providerResult({ status: SourceStatus.NA, source: "flashscore.verification", data: [], meta: { outcome: FlashscoreOutcome.UNSUPPORTED, reason: "DISABLED", shadowOnly: true } });
  let requestsUsed = 0; let cacheHits = 0;
  const inFlight = new Map();
  const fetchCached = async (key, url, ttl) => {
    const cached = cache.get(key, ttl, now);
    if (cached) { cacheHits += 1; return cached; }
    if (inFlight.has(url)) return inFlight.get(url);
    const pending = httpClient.fetchText(url, { retry: 1, userAgent: "FVM-Verification/1.0 (public Flashscore read-only)" }).then(html => { requestsUsed += 1; cache.set(key, html, now); return html; });
    inFlight.set(url, pending);
    try { return await pending; } finally { inFlight.delete(url); }
  };
  try {
    const indexHtml = await fetchCached("flashscore:index", `${BASE_URL}/`, indexTtlMinutes);
    if (/cf-chl-|challenge-error-text|verify you are human/i.test(indexHtml)) return providerResult({ status: SourceStatus.NA, source: "flashscore.verification", data: [], meta: { outcome: FlashscoreOutcome.BLOCKED, requestsUsed, cacheHits, shadowOnly: true } });
    const candidates = parseFlashscoreIndex(indexHtml);
    if (!candidates.length) return providerResult({ status: SourceStatus.NA, source: "flashscore.verification", data: [], meta: { outcome: FlashscoreOutcome.PARSE_ERROR, requestsUsed, cacheHits, candidates: 0, shadowOnly: true } });
    const data = []; const unmatched = [];
    for (const fixture of fixtures) {
      const match = matchFlashscoreFixture(fixture, candidates);
      if (!match) { unmatched.push(String(fixture.id)); continue; }
      const id = match.candidate.externalId;
      const summary = await fetchCached(`flashscore:${id}:summary`, match.candidate.detailUrl, detailTtlMinutes);
      const lineup = await fetchCached(`flashscore:${id}:lineups`, `${match.candidate.detailUrl}?s=2.&t=lineups`, detailTtlMinutes);
      const stats = await fetchCached(`flashscore:${id}:stats`, `${match.candidate.detailUrl}?s=2.&t=stats`, detailTtlMinutes);
      const h2h = await fetchCached(`flashscore:${id}:h2h`, `${match.candidate.detailUrl}?s=2.&t=h2h`, 360);
      const normalized = parseFlashscoreDetail({ summaryHtml: summary, lineupHtml: lineup, statsHtml: stats, h2hHtml: h2h, matched: match.candidate });
      if (normalized.kickoff?.date && normalized.kickoff.date !== String(fixture.utcDate).slice(0, 10)) { unmatched.push(String(fixture.id)); continue; }
      data.push({ fixtureId: String(fixture.id), matchConfidence: match.confidence, facts: normalized, sourceComparison: compareFlashscoreFacts({ fixture, flashscore: normalized }) });
    }
    return providerResult({ status: data.length ? (unmatched.length ? SourceStatus.PARTIAL : SourceStatus.OK) : SourceStatus.NA, source: "flashscore.verification", data, meta: { outcome: data.length ? (unmatched.length ? FlashscoreOutcome.PARTIAL : FlashscoreOutcome.OK) : FlashscoreOutcome.OK, requestsUsed, cacheHits, candidates: candidates.length, fixturesChecked: fixtures.length, fixturesMatched: data.length, unmatched, shadowOnly: true } });
  } catch (error) {
    const outcome = classifiedError(error);
    return providerResult({ status: outcome === FlashscoreOutcome.BLOCKED ? SourceStatus.NA : SourceStatus.ERROR, source: "flashscore.verification", data: [], error: { code: outcome, message: error.message }, meta: { outcome, requestsUsed, cacheHits, shadowOnly: true, nonFatal: true } });
  }
}
