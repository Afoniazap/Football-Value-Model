import { sameTeamIdentity } from "../history/teamAliases.js";

// Strict club-name identity and fixture<->odds-event matching.
// Adapted from the reviewed matcher of PR #1 (main). Character/bigram overlap and
// bare substring inclusion are NOT identity ("Santos" vs "Santos Laguna",
// "Manchester City" vs "Manchester United"); when in doubt the event is rejected.

// Words that carry no club identity (legal/sporting prefixes, articles, founding years).
const NOISE_TOKENS = new Set([
  "fc", "cf", "afc", "ac", "ec", "sc", "cd", "rcd", "sv", "fk", "sk", "ssc", "ca", "se", "calcio", "football",
  "sport", "clube", "club", "de", "da", "do", "del", "e", "the", "1", "04", "05", "96", "1899", "1909", "1913"
]);
// Spelling variants of the same club word used by different providers.
const TOKEN_SYNONYMS = new Map([
  ["munchen", "munich"], ["koln", "cologne"], ["cp", "portugal"], ["utd", "united"], ["man", "manchester"], ["and", "&"]
]);
// Qualifiers that make a club a different team (women's / reserve / youth sides).
const SQUAD_QUALIFIERS = new Set([
  "women", "w", "ladies", "fem", "feminino", "femenino", "b", "ii", "iii", "u17", "u18", "u19", "u20", "u21", "u23", "res", "reserves", "youth"
]);
// Extra words that may follow a club's short name without changing its identity.
const GENERIC_SUFFIX_TOKENS = new Set([
  "united", "city", "town", "county", "albion", "rovers", "wanderers", "hotspur",
  // Brazilian state suffixes ("Vitoria BA", "Cruzeiro MG")
  "ba", "mg", "sp", "rj", "rs", "pr", "go", "pe", "ce", "pa", "mt", "ms"
]);
// Bare city names shared by several clubs: never enough to identify one.
const AMBIGUOUS_BARE_TOKENS = new Set([
  "manchester", "sheffield", "madrid", "milan", "nottingham", "bristol", "birmingham", "london", "munich", "lisbon", "belgrade", "bucharest", "istanbul"
]);
// Confirmed provider spellings (normalized form -> canonical form), on top of TEAM_ALIAS_GROUPS.
const CLUB_ALIASES = new Map([
  ["wolves", "wolverhampton wanderers"],
  ["spurs", "tottenham hotspur"],
  ["brighton", "brighton and hove albion"],
  ["brighton hove albion", "brighton and hove albion"],
  ["athletic bilbao", "athletic"],
  ["gladbach", "borussia monchengladbach"],
  ["sport lisboa e benfica", "benfica"],
  ["sporting clube de portugal", "sporting cp"],
  ["real betis balompie", "real betis"],
  ["real sociedad de futbol", "real sociedad"],
  ["rcd espanyol de barcelona", "espanyol"],
  ["espanyol de barcelona", "espanyol"],
  ["internazionale", "inter"], ["internazionale milano", "inter"], ["inter milan", "inter"], ["inter milano", "inter"],
  ["paris saint germain", "psg"], ["paris st germain", "psg"],
  ["vitoria sc", "vitoria guimaraes"],
  ["olympique marseille", "marseille"], ["olympique de marseille", "marseille"]
]);

function stripMarks(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}+/gu, "");
}

function tokens(value) {
  const cleaned = stripMarks(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9а-яё]+/gi, " ").trim().replace(/\s+/g, " ");
  const stripped = cleaned.split(" ").filter(token => token && !NOISE_TOKENS.has(token)).join(" ");
  const aliased = CLUB_ALIASES.get(cleaned) || CLUB_ALIASES.get(stripped) || cleaned;
  const all = aliased.split(" ").filter(Boolean).map(token => TOKEN_SYNONYMS.get(token) || token);
  const meaningful = all.filter(token => !NOISE_TOKENS.has(token) && token !== "&");
  return meaningful.length ? meaningful : all;
}

function editRatio(a, b) {
  if (a === b) return 1;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length, 1);
}

function sameToken(a, b) {
  return a === b || (Math.min(a.length, b.length) >= 5 && editRatio(a, b) >= 0.8);
}

const qualifiers = list => list.filter(t => SQUAD_QUALIFIERS.has(t)).sort().join(",");

// 1 = same club (identical or confirmed alias), 0.85 = short form of the same club
// (only generic suffix words differ), otherwise <= 0.6 (never treated as the same club).
export function clubNameSimilarity(a, b) {
  const tx = tokens(a);
  const ty = tokens(b);
  if (!tx.length || !ty.length) return 0;
  if (qualifiers(tx) !== qualifiers(ty)) return 0;
  if (tx.join(" ") === ty.join(" ") || sameTeamIdentity(a, b)) return 1;
  const [short, long] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  const common = short.filter(t => long.some(u => sameToken(t, u))).length;
  if (common === short.length) {
    if (common === long.length) return 1;
    if (short.length === 1 && AMBIGUOUS_BARE_TOKENS.has(short[0])) return 0;
    const extras = long.filter(u => !short.some(t => sameToken(t, u)));
    return extras.every(u => GENERIC_SUFFIX_TOKENS.has(u)) ? 0.85 : 0;
  }
  return Number(((common / long.length) * 0.6).toFixed(4));
}

const CLUB_MATCH_MIN = 0.85;

function text(value) {
  return typeof value === "string" ? value : null;
}

/**
 * Pick the odds event for a fixture. Rejects reversed home/away, other competitions,
 * other countries, women's/youth/reserve sides and ambiguous short names; among valid
 * candidates the closest kickoff wins. An event without a kickoff time is accepted
 * only when both team names are identical/confirmed aliases.
 *
 * options: teamsOf(event)->{home,away}, kickoffOf(event), competitionOf(event)->string|null,
 * expectedCompetition (string|null), knownCompetitions (Set; a mismatch only counts when
 * the event's competition is one of these), countryOf(event), maxMinutes.
 */
export function matchEventToFixture(fixture, events, {
  teamsOf, kickoffOf, competitionOf = () => null, expectedCompetition = null,
  knownCompetitions = null, countryOf = () => null, maxMinutes = 180
}) {
  const fixtureTime = new Date(fixture.utcDate).getTime();
  const fixtureCountry = text(fixture.country);
  let best = null;
  let considered = 0;
  for (const event of events || []) {
    const teams = teamsOf(event);
    const home = clubNameSimilarity(fixture.home, teams.home);
    const away = clubNameSimilarity(fixture.away, teams.away);
    if (home < CLUB_MATCH_MIN || away < CLUB_MATCH_MIN) continue;
    const competition = text(competitionOf(event));
    if (expectedCompetition && competition && competition !== expectedCompetition
      && (!knownCompetitions || knownCompetitions.has(competition))) continue;
    const eventCountry = text(countryOf(event));
    if (fixtureCountry && eventCountry && clubNameSimilarity(fixtureCountry, eventCountry) < 1) continue;
    const kickoff = kickoffOf(event);
    let minutes = null;
    if (kickoff) {
      const eventTime = new Date(kickoff).getTime();
      if (!Number.isFinite(fixtureTime) || !Number.isFinite(eventTime)) continue;
      minutes = Math.abs(fixtureTime - eventTime) / 60_000;
      if (minutes > maxMinutes) continue;
    } else if (home < 1 || away < 1) continue;
    considered += 1;
    const time = minutes === null ? 0.5 : 1 - minutes / maxMinutes;
    const confidence = Number((((home + away) / 2) * 0.8 + time * 0.2).toFixed(4));
    if (!best || (minutes ?? Infinity) < (best.minutes ?? Infinity)
      || ((minutes ?? Infinity) === (best.minutes ?? Infinity) && confidence > best.confidence)) {
      best = { event, confidence, minutes, home, away };
    }
  }
  return best ? { ...best, candidates: considered } : null;
}
