import { ContextCategory, ContextEventType, ContextInformationLevel, ContextSentiment, ContextTarget, EvidenceType, normalizeContextEvent } from "./contextTypes.js";
import { normalizeClubName } from "./fixtureMatching.js";

function decode(value = "") {
  return String(value).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)));
}

export function stripHtml(value = "") {
  return decode(String(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function absoluteUrl(href, baseUrl) {
  try { return new URL(decode(href), baseUrl).toString(); } catch { return null; }
}

export function discoverArticleLinks(html, source) {
  const host = new URL(source.baseUrl).host;
  const seen = new Set();
  const items = [];
  for (const match of String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(match[1], source.baseUrl);
    const title = stripHtml(match[2]);
    if (!url || new URL(url).host !== host || !url.includes(source.linkPattern) || title.length < 8 || seen.has(url)) continue;
    seen.add(url);
    items.push({ url, title });
  }
  return items;
}

function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decode(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)`, "i"))?.[1] ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"))?.[1] || "");
}

function jsonLdValue(html, key) {
  return decode(html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i"))?.[1] || "");
}

export function parseArticlePage(html, fallback = {}) {
  const title = meta(html, "og:title") || jsonLdValue(html, "headline") || stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || fallback.title || "";
  const publishedAt = meta(html, "article:published_time") || jsonLdValue(html, "datePublished") || html.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1] || null;
  const author = meta(html, "author") || jsonLdValue(html, "name") || null;
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html;
  const paragraphs = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match => stripHtml(match[1])).filter(text => text.length >= 30);
  return { title, publishedAt, author, text: paragraphs.slice(0, 12).join(" ").slice(0, 6_000), url: fallback.url || "" };
}

const signalRules = [
  { type: "STRONGEST_XI", eventType: ContextEventType.ROTATION_EXPECTED, pattern: /strongest (?:xi|line-?up)|full-strength/i, category: ContextCategory.ROTATION_HINT, sentiment: ContextSentiment.POSITIVE, flag: "rotationHint" },
  { type: "ROTATION_EXPECTED", eventType: ContextEventType.ROTATION_EXPECTED, pattern: /rotat(?:e|ion|ing)|make changes to (?:the )?(?:team|side)/i, category: ContextCategory.ROTATION_HINT, sentiment: ContextSentiment.NEGATIVE, flag: "rotationHint" },
  { type: "PLAYER_RESTED", eventType: ContextEventType.REST_PRIORITY, pattern: /(?:will|set to|expected to) (?:be )?rested|given a rest/i, category: ContextCategory.FATIGUE_HINT, sentiment: ContextSentiment.NEGATIVE, flag: "fatigueHint" },
  { type: "PLAYER_DOUBTFUL", pattern: /doubtful|late fitness test|unlikely to feature/i, category: ContextCategory.CLUB_NEWS, sentiment: ContextSentiment.NEGATIVE },
  { type: "FATIGUE", pattern: /fatigue|tired legs|physically drained/i, category: ContextCategory.FATIGUE_HINT, sentiment: ContextSentiment.NEGATIVE, flag: "fatigueHint" },
  { type: "TRAVEL_DIFFICULTY", eventType: ContextEventType.TRAVEL_ISSUE, pattern: /travel disruption|travel difficult|flight (?:delay|cancel)/i, category: ContextCategory.TRAVEL_PROBLEM, sentiment: ContextSentiment.NEGATIVE },
  { type: "COACH_PRESSURE", eventType: ContextEventType.PUBLIC_PRESSURE, pattern: /coach under pressure|manager under pressure|must win to save/i, category: ContextCategory.INTERNAL_CONFLICT, sentiment: ContextSentiment.NEGATIVE, flag: "internalConflict" },
  { type: "MANAGEMENT_ULTIMATUM", eventType: ContextEventType.MANAGEMENT_CONFLICT, pattern: /ultimatum|final warning from (?:the )?(?:board|management)/i, category: ContextCategory.INTERNAL_CONFLICT, sentiment: ContextSentiment.NEGATIVE, flag: "internalConflict" },
  { type: "PRESIDENT_VISIT", eventType: ContextEventType.PRESIDENT_VISIT, pattern: /(?:president|owner) (?:visited|arrived|met (?:with )?the squad)/i, category: ContextCategory.PRESIDENT_VISIT, sentiment: ContextSentiment.POSITIVE, flag: "presidentVisit" },
  { type: "BONUS_PROMISED", eventType: ContextEventType.BONUS_PROMISE, pattern: /bonus (?:promised|offered)|win bonus/i, category: ContextCategory.BONUS, sentiment: ContextSentiment.POSITIVE, flag: "bonusPromise" },
  { type: "PAYMENT_PROBLEM", pattern: /unpaid (?:wages|salaries)|salary arrears|payment problems/i, category: ContextCategory.FINANCIAL_PROBLEM, sentiment: ContextSentiment.NEGATIVE, flag: "financialProblems" },
  { type: "INTERNAL_CONFLICT", eventType: ContextEventType.MANAGEMENT_CONFLICT, pattern: /internal conflict|dressing-room rift|fell out with/i, category: ContextCategory.INTERNAL_CONFLICT, sentiment: ContextSentiment.NEGATIVE, flag: "internalConflict" },
  { type: "DERBY_MOTIVATION", eventType: ContextEventType.MOTIVATION_HIGH, pattern: /derby|rivalry/i, category: ContextCategory.MOTIVATION, sentiment: ContextSentiment.POSITIVE, flag: "strongMotivation" },
  { type: "TABLE_PRESSURE", pattern: /title race|relegation battle|promotion (?:race|push)|must-win/i, category: ContextCategory.MOTIVATION, sentiment: ContextSentiment.NEUTRAL, flag: "strongMotivation" },
  { type: "TACTICAL_CHANGE", pattern: /tactical change|change (?:of|in) formation|switch to a [0-9]-[0-9]/i, category: ContextCategory.TACTICAL_HINT, sentiment: ContextSentiment.NEUTRAL, flag: "tacticalHint" },
  { type: "FIXTURE_CONGESTION", pattern: /fixture congestion|third game in|games in (?:seven|eight|nine|ten) days/i, category: ContextCategory.FATIGUE_HINT, sentiment: ContextSentiment.NEGATIVE, flag: "fatigueHint" }
];

function snippetAround(text, match, radius = 110) {
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return text.slice(start, end).trim().slice(0, 260);
}

export function extractContextSignals(article) {
  const content = `${article.title}. ${article.text}`;
  return signalRules.flatMap(rule => {
    const match = rule.pattern.exec(content);
    return match ? [{ type: rule.type, eventType: rule.eventType || ContextEventType.SQUAD_NEWS, category: rule.category, sentiment: rule.sentiment, flag: rule.flag || null, snippet: snippetAround(content, match), extractionMethod: `RULE:${rule.type}` }] : [];
  });
}

export function extractQuote(article, sourceTeam = "") {
  const quoteMatch = article.text.match(/[“"]([^”"]{20,320})[”"]/);
  if (!quoteMatch) return null;
  const before = article.text.slice(Math.max(0, quoteMatch.index - 120), quoteMatch.index);
  if (!/said|says|added|told|explained|according to/i.test(before)) return null;
  const speaker = before.match(/([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+){0,2})\s+(?:said|says|added|told|explained)/)?.[1] || null;
  const role = /coach|manager|head coach/i.test(`${article.title} ${before}`) ? "COACH"
    : /player|midfielder|forward|defender|goalkeeper|captain/i.test(`${article.title} ${before}`) ? "PLAYER"
      : /director|president|owner|chairman/i.test(`${article.title} ${before}`) ? "MANAGEMENT" : "UNKNOWN";
  return { speaker, role, team: sourceTeam || null, quoteText: quoteMatch[1].trim(), sourceUrl: article.url, publishedAt: article.publishedAt };
}

export function classifyArticle({ article, source, fixture, target }) {
  const signals = extractContextSignals(article);
  const quote = extractQuote(article, source.teams[0]);
  const quoteCategory = quote?.role === "COACH" ? ContextCategory.COACH_INTERVIEW
    : quote?.role === "PLAYER" ? ContextCategory.PLAYER_INTERVIEW
      : quote?.role === "MANAGEMENT" ? ContextCategory.MANAGEMENT_INTERVIEW : null;
  const primary = signals[0];
  const genericMotivation = Boolean(quote && !primary && /(?:give everything|fight until the end|believe in (?:ourselves|the team)|one game at a time|fully focused|do our best)/i.test(quote.quoteText));
  const category = quoteCategory || primary?.category || ContextCategory.CLUB_NEWS;
  const extracted = { signals };
  for (const signal of signals) if (signal.flag) extracted[signal.flag] = true;
  if (quote?.role === "COACH") extracted.coachQuote = quote.quoteText;
  if (quote?.role === "PLAYER") extracted.playerQuote = quote.quoteText;
  extracted.quote = quote;
  return normalizeContextEvent({
    source: source.id, sourceType: source.type,
    evidenceType: quote ? EvidenceType.QUOTE : /official statement/i.test(article.title) ? EvidenceType.FACT : EvidenceType.REPORT,
    competition: fixture.competitionCode, homeTeam: fixture.home, awayTeam: fixture.away,
    fixtureDate: fixture.utcDate, publishedAt: article.publishedAt, author: article.author, url: article.url,
    title: article.title, text: article.text.slice(0, 1_200), category,
    eventType: quote?.role === "COACH" ? ContextEventType.COACH_INTERVIEW
      : quote?.role === "PLAYER" ? ContextEventType.PLAYER_INTERVIEW
        : primary?.eventType || ContextEventType.SQUAD_NEWS,
    informationLevel: genericMotivation ? ContextInformationLevel.LOW_INFORMATION
      : primary ? ContextInformationLevel.HIGH : ContextInformationLevel.STANDARD,
    sentiment: primary?.sentiment || ContextSentiment.NEUTRAL, target,
    sourceReliability: source.reliability, relevance: genericMotivation ? 20 : 80, freshness: 100, contextConfidence: 0,
    tags: [...signals.map(signal => signal.type.toLowerCase()), quote?.role?.toLowerCase()].filter(Boolean),
    extracted,
    evidence: {
      sourceUrl: article.url, title: article.title, publishedAt: article.publishedAt,
      snippet: (primary?.snippet || quote?.quoteText || article.text).slice(0, 260),
      speaker: quote?.speaker || null,
      extractionMethod: quote ? "DIRECT_QUOTE_RULE" : primary?.extractionMethod || "OFFICIAL_ARTICLE"
    }
  });
}

export function articleFixtureCandidate(item, source, fixtures) {
  const haystack = normalizeClubName(`${item.title} ${item.url}`);
  const candidates = fixtures.filter(fixture => source.competitions.includes(fixture.competitionCode) &&
    (!source.teams.length || source.teams.some(team => normalizeClubName(team) === normalizeClubName(fixture.home) || normalizeClubName(team) === normalizeClubName(fixture.away))));
  let best = null;
  for (const fixture of candidates) {
    const home = normalizeClubName(fixture.home);
    const away = normalizeClubName(fixture.away);
    const sourceOwnsHome = source.teams.some(team => normalizeClubName(team) === home);
    const sourceOwnsAway = source.teams.some(team => normalizeClubName(team) === away);
    const homeHit = haystack.includes(home);
    const awayHit = haystack.includes(away);
    const confidence = source.teams.length
      ? ((sourceOwnsHome && awayHit) || (sourceOwnsAway && homeHit) ? 95 : 0)
      : (homeHit && awayHit ? 95 : 0);
    if (confidence && (!best || confidence > best.confidence)) best = { fixture, confidence, target: sourceOwnsHome ? ContextTarget.HOME : sourceOwnsAway ? ContextTarget.AWAY : ContextTarget.MATCH };
  }
  return best;
}
