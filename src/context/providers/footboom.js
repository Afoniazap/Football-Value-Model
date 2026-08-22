import { providerResult, SourceStatus } from "../../providers/providerResult.js";
import { ContextCategory, ContextSentiment, ContextTarget, EvidenceType, normalizeContextEvent } from "../contextTypes.js";

const SOURCE = "context.footboom";

function text(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function articleBlocks(html) {
  return [...String(html || "").matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)].map(match => ({ attrs: match[1], body: match[2] }));
}

function attr(attrs, name) {
  return attrs.match(new RegExp(`data-${name}=["']([^"']*)["']`, "i"))?.[1] || "";
}

export function parseFootboomForecasts(html, { reliability = 60, now = new Date() } = {}) {
  if (/challenge-error-text|cf-chl-/i.test(String(html || ""))) return [];
  return articleBlocks(html).map(({ attrs, body }) => {
    const title = text(body.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1]);
    const teams = (attr(attrs, "match") || title).split(/\s+(?:vs\.?|v|[-–—])\s+/i);
    const url = body.match(/<a[^>]+href=["']([^"']+)["']/i)?.[1] || "";
    const publishedAt = attr(attrs, "published-at") || body.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1] || null;
    const oddsRaw = attr(attrs, "odds") || text(body.match(/(?:odds|коэффициент)[^0-9]*([0-9]+[.,][0-9]+)/i)?.[1]);
    const event = normalizeContextEvent({
      source: "footboom", sourceType: ContextCategory.EXPERT_FORECAST, evidenceType: EvidenceType.EXPERT_OPINION,
      homeTeam: teams[0] || attr(attrs, "home"), awayTeam: teams[1] || attr(attrs, "away"),
      publishedAt, url, title, text: text(body), category: ContextCategory.EXPERT_FORECAST,
      sentiment: ContextSentiment.NEUTRAL, target: ContextTarget.MATCH,
      sourceReliability: reliability, relevance: 70, freshness: publishedAt ? 100 : 0,
      contextConfidence: publishedAt ? 55 : 40,
      tags: ["footboom", "forecast"],
      extracted: {
        market: attr(attrs, "market") || null,
        selection: attr(attrs, "selection") || null,
        odds: Number(String(oddsRaw).replace(",", ".")) || null,
        author: attr(attrs, "author") || null,
        reasoning: text(body.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]) || null
      }
    });
    if (publishedAt && new Date(publishedAt) > now) event.freshness = 0;
    return event;
  }).filter(event => event.title || event.homeTeam || event.awayTeam);
}

async function defaultFetchPage(url, { timeoutSeconds, userAgent }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "text/html" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } finally { clearTimeout(timeout); }
}

export async function fetchFootboomForecasts({ fetchPage = defaultFetchPage, timeoutSeconds = 15, reliability = 60, now = new Date() } = {}) {
  try {
    let html;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        html = await fetchPage("https://www.footboom1.com/forecast", { timeoutSeconds, userAgent: "FVM-Context/1.0 (+respectful cached research)" });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (html === undefined) throw lastError;
    if (/challenge-error-text|cf-chl-/i.test(html)) {
      return providerResult({ status: SourceStatus.NA, source: SOURCE, data: [], meta: { reason: "CLOUDFLARE_CHALLENGE" } });
    }
    const events = parseFootboomForecasts(html, { reliability, now });
    return providerResult({ status: events.length ? SourceStatus.OK : SourceStatus.NA, source: SOURCE, data: events, meta: { parsed: events.length, reason: events.length ? null : "NO_SUPPORTED_ARTICLES" } });
  } catch (error) {
    return providerResult({ status: SourceStatus.ERROR, source: SOURCE, data: [], error: { code: error.name || "ERROR", message: error.message }, meta: { nonFatal: true } });
  }
}
