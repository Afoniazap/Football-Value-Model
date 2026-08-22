import { ContextSentiment, ContextTarget } from "./contextTypes.js";

export function freshnessScore(publishedAt, now = new Date(), halfLifeHours = 48) {
  const age = now.getTime() - new Date(publishedAt).getTime();
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.round(100 * Math.pow(0.5, age / (halfLifeHours * 3_600_000)));
}

function overlaps(left, right) {
  const a = new Set(left.tags || []);
  return [...(right.tags || [])].some(tag => a.has(tag));
}

export function markContradictions(events = []) {
  return events.map((event, index) => ({
    ...event,
    contradiction: events.some((other, otherIndex) => otherIndex !== index &&
      event.target === other.target && event.target !== ContextTarget.UNKNOWN &&
      event.sentiment !== ContextSentiment.NEUTRAL && other.sentiment !== ContextSentiment.NEUTRAL &&
      event.sentiment !== other.sentiment && overlaps(event, other))
  }));
}

function aggregateSide(events, target) {
  const selected = events.filter(event => event.target === target);
  let positive = 0;
  let negative = 0;
  let signed = 0;
  let weight = 0;
  for (const event of selected) {
    const confidence = (event.sourceReliability * event.relevance * event.freshness) / 10_000;
    if (event.sentiment === ContextSentiment.POSITIVE) positive += confidence;
    if (event.sentiment === ContextSentiment.NEGATIVE) negative += confidence;
    const direction = event.sentiment === ContextSentiment.POSITIVE ? 1 : event.sentiment === ContextSentiment.NEGATIVE ? -1 : 0;
    signed += direction * confidence;
    weight += confidence;
  }
  return {
    positive: Math.min(100, Math.round(positive)),
    negative: Math.min(100, Math.round(negative)),
    confidence: selected.length ? Math.round(selected.reduce((sum, event) => sum + event.contextConfidence, 0) / selected.length) : 0,
    score: Math.max(-100, Math.min(100, Math.round(signed / Math.max(1, Math.sqrt(selected.length)))))
  };
}

export function aggregateContext(events = []) {
  const marked = markContradictions(events);
  const contradictions = Math.ceil(marked.filter(event => event.contradiction).length / 2);
  const relevant = marked.filter(event => event.target !== ContextTarget.UNKNOWN);
  return {
    home: aggregateSide(marked, ContextTarget.HOME),
    away: aggregateSide(marked, ContextTarget.AWAY),
    match: {
      intensity: Math.min(100, Math.round(relevant.reduce((sum, event) => sum + event.relevance, 0) / Math.max(1, relevant.length))),
      uncertainty: Math.min(100, Math.round((contradictions / Math.max(1, marked.length)) * 100))
    },
    confidence: relevant.length ? Math.round(relevant.reduce((sum, event) => sum + event.contextConfidence, 0) / relevant.length) : 0,
    independentSources: new Set(marked.flatMap(event => event.independentSourcesCount > 1 ? [`group:${event.url || event.title}`] : [event.source])).size,
    contradictions,
    events: marked
  };
}
