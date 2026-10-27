import { canonicalTeamName, isProtectedFullForm, sameTeamIdentity } from "./teamAliases.js";

// RELAXED identity: a conservative fallback for the case where two providers
// spell ONE club differently and no curated alias exists yet ("Bolton" vs
// "Bolton Wanderers FC", "Willem II" vs "Willem II Tilburg", "Sheffield Utd"
// vs "Sheffield United FC"). It never replaces STRICT identity: callers must
// additionally require exact kickoff, verified competition, home/away
// orientation and a unique candidate (see resultMatching.js).
//
// Rule: after dropping legal-form tokens and normalising "utd"->"united",
// the token sets must be equal, or one must be a strict subset of the other
// with at least one distinctive token (length >= 4) in the shared part and every
// extra token drawn from ALLOWED_EXTRA.
const GENERIC_TOKENS = new Set(["fc","afc","cf","sc","ac","cd","fk","rc","ca","ud","club","sk","vv","kf","ec","sbv","ssc","us","as","cr","sv","tsg","bk","fbc","fr","ssd","calcio","de","da","do","the"]);
const SYNONYMS = new Map([["utd", "united"], ["intl", "international"]]);
// Tokens that may appear ONLY on the longer spelling of the same club
// ("Swansea" -> "Swansea City", "Bolton" -> "Bolton Wanderers",
// "Preston" -> "Preston North End"). Anything else (Galaxy, Saint Germain,
// Espanyol, Potosi, U21, W, B...) names a different club or side, so the pair
// is NOT relaxed-equal. Found by scanning every club name per competition in
// the real history: an open "subset" rule merged Los Angeles FC/Galaxy,
// Paris FC/PSG and Barcelona/Espanyol.
const ALLOWED_EXTRA = new Set(["city","town","united","rovers","wanderers","county","albion","hotspur","north","end"]);

function tokens(value) {
  const base = String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return base.map(token => SYNONYMS.get(token) || token).filter(token => !GENERIC_TOKENS.has(token));
}

/**
 * @returns {"STRICT"|"RELAXED"|null} how `left` and `right` name the same club.
 */
export function teamIdentityLevel(left, right) {
  if (!canonicalTeamName(left) || !canonicalTeamName(right)) return null;
  if (sameTeamIdentity(left, right)) return "STRICT";
  // Protected names (e.g. "Vitória SC", Portugal) are never widened.
  if (isProtectedFullForm(left) || isProtectedFullForm(right)) return null;
  const a = tokens(left), b = tokens(right);
  if (!a.length || !b.length) return null;
  const setA = new Set(a), setB = new Set(b);
  const equal = setA.size === setB.size && [...setA].every(token => setB.has(token));
  if (equal) return "RELAXED";
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  if (small.size === large.size || ![...small].every(token => large.has(token))) return null;
  if (![...small].some(token => token.length >= 4 && !/\d/.test(token))) return null;
  const extra = [...large].filter(token => !small.has(token));
  if (extra.some(token => !ALLOWED_EXTRA.has(token))) return null;
  return "RELAXED";
}

// Competition names as written by fixture discovery -> provider competition codes.
const NAME_TO_CODES = new Map([
  ["championship", ["ELC"]], ["efl championship", ["ELC"]],
  ["premier league", ["PL"]],
  ["serie a", ["SA", "BSA"]], ["campeonato brasileiro serie a", ["BSA"]],
  ["serie b", ["BSB", "SB"]],
  ["primera division", ["PD"]], ["la liga", ["PD"]],
  ["primeira liga", ["PPL"]], ["eredivisie", ["DED"]], ["ligue 1", ["FL1"]], ["bundesliga", ["BL1"]],
  ["major league soccer", ["MLS"]], ["uefa champions league", ["CL"]], ["uefa europa league", ["EL"]],
  ["copa libertadores", ["CLI"]], ["conmebol libertadores", ["CLI"]], ["conmebol sudamericana", ["SUD"]]
]);

function normName(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * @returns {boolean|null} true = same competition, false = different,
 *   null = cannot be verified (unknown on either side).
 */
export function competitionsCompatible(prediction, row) {
  const wanted = prediction.competitionCode
    ? [String(prediction.competitionCode).toUpperCase()]
    : NAME_TO_CODES.get(normName(prediction.competition)) || null;
  const rowCode = row.competition?.code ? String(row.competition.code).toUpperCase() : null;
  const rowName = normName(row.competition?.name);
  if (wanted && rowCode) return wanted.includes(rowCode);
  if (wanted && rowName) {
    const rowCodes = NAME_TO_CODES.get(rowName);
    if (rowCodes) return rowCodes.some(code => wanted.includes(code));
  }
  if (normName(prediction.competition) && rowName && normName(prediction.competition) === rowName) return true;
  return null;
}
