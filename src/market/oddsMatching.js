import { normalizeClubName } from "../context/fixtureMatching.js";

function stripMarks(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}+/gu, "");
}

// Words that carry no club identity (legal/sporting prefixes, articles, ordinals, numbers).
const NOISE_TOKENS = new Set([
  "ec", "sc", "cd", "rcd", "sv", "fk", "sk", "ssc", "ca", "se", "sport", "clube", "club",
  "de", "da", "do", "del", "e", "the", "1", "04", "05", "96", "1899", "1909", "1913"
]);
// Spelling variants of the same club word used by different providers.
const TOKEN_SYNONYMS = new Map([
  ["munchen", "munich"], ["koln", "cologne"], ["cp", "portugal"], ["and", "&"]
]);
// Qualifiers that make a club a different team (women's / reserve / youth sides).
const SQUAD_QUALIFIERS = new Set([
  "women", "w", "ladies", "fem", "feminino", "femenino", "b", "ii", "iii", "u17", "u18", "u19", "u20", "u21", "u23", "res", "reserves", "youth"
]);

// Confirmed long-form/short-form aliases (normalized form -> canonical form).
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
  ["espanyol de barcelona", "espanyol"]
]);
// Extra words that may follow a club's short name without changing the club identity.
const GENERIC_SUFFIX_TOKENS = new Set(["united", "city", "town", "county", "albion", "rovers", "wanderers", "hotspur",
  // Brazilian state suffixes ("Vitoria BA", "Cruzeiro MG")
  "ba", "mg", "sp", "rj", "rs", "pr", "go", "pe", "ce", "pa", "mt", "ms"]);

// Bare city names shared by several clubs: never enough to identify one ("Manchester" is
// United or City, "Sheffield" is United or Wednesday).
const AMBIGUOUS_BARE_TOKENS = new Set([
  "manchester", "sheffield", "madrid", "milan", "nottingham", "bristol", "birmingham", "london", "munich", "lisbon", "belgrade", "bucharest", "istanbul"
]);

function tokens(value) {
  const normalized = normalizeClubName(stripMarks(value));
  const shared = CLUB_ALIASES.get(normalized) || normalized;
  const all = String(shared || "").replace(/&/g, " and ").split(/\s+/).filter(Boolean)
    .map(token => TOKEN_SYNONYMS.get(token) || token);
  const meaningful = all.filter(token => !NOISE_TOKENS.has(token) && token !== "&");
  return meaningful.length ? meaningful : all;
}

function normalize(value) {
  return tokens(value).join("");
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

// Token-based club-name similarity. Character-set overlap (previous implementation)
// scored unrelated clubs such as "Real Madrid" / "Real Sociedad" or "Inter" /
// "Internacional" high enough to match the wrong event and attach foreign odds.
function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = tokens(a);
  const ty = tokens(b);
  const [short, long] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  const hasQualifier = list => list.some(t => SQUAD_QUALIFIERS.has(t));
  const qualifiers = list => list.filter(t => SQUAD_QUALIFIERS.has(t)).sort().join(",");
  if (hasQualifier(tx) || hasQualifier(ty)) {
    if (qualifiers(tx) !== qualifiers(ty)) return 0;
  }
  const common = short.filter(t => long.some(u => sameToken(t, u))).length;
  if (common === short.length) {
    // Containment alone is not identity ("Santos" vs "Santos Laguna", "Newcastle" vs
    // "Newcastle Jets"): the extra words must be generic suffixes, otherwise reject.
    const extras = long.filter(u => !short.some(t => sameToken(t, u)));
    if (short.length === 1 && AMBIGUOUS_BARE_TOKENS.has(short[0])) return 0;
    return extras.every(u => GENERIC_SUFFIX_TOKENS.has(u)) ? 0.85 : 0;
  }
  return Number(((common / long.length) * 0.6).toFixed(4));
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
  if (home < 0.4 || away < 0.4) return 0;
  const kickoff = kickoffConfidence(fixture.utcDate, event.commence_time);
  if (event.sport_key && fixture.sportKey && event.sport_key !== fixture.sportKey) return 0;
  if (event.country && fixture.country && normalize(event.country) !== normalize(fixture.country)) return 0;
  const competition = !event.sport_key || !fixture.sportKey || event.sport_key === fixture.sportKey ? 1 : 0.65;
  return Number(((home * 0.35) + (away * 0.35) + (kickoff * 0.2) + (competition * 0.1)).toFixed(4));
}

export { similarity as clubNameSimilarity };

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
