function normalized(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9а-яё]+/giu, " ").trim();
}

function tokens(event) {
  return new Set(normalized(`${event.title} ${event.text}`).split(" ").filter(word => word.length > 2));
}

function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

function closeInTime(left, right, hours = 48) {
  const a = new Date(left.publishedAt).getTime();
  const b = new Date(right.publishedAt).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= hours * 3_600_000;
}

function sameStory(left, right) {
  if (left.url && right.url && normalized(left.url) === normalized(right.url)) return true;
  const sameFixture = left.fixtureId && left.fixtureId === right.fixtureId;
  const sameTeams = normalized(left.homeTeam) === normalized(right.homeTeam) && normalized(left.awayTeam) === normalized(right.awayTeam);
  return (sameFixture || sameTeams) && closeInTime(left, right) && similarity(left, right) >= 0.72;
}

export function dedupeContextEvents(events = []) {
  const unique = [];
  for (const event of events) {
    const existing = unique.find(item => sameStory(item, event));
    if (!existing) {
      unique.push({ ...event, independentSourcesCount: 1 });
      continue;
    }
    const sources = new Set([...(existing._sources || [existing.source]), event.source]);
    existing._sources = [...sources];
    existing.independentSourcesCount = sources.size;
    if ((event.sourceReliability || 0) > (existing.sourceReliability || 0)) {
      const count = existing.independentSourcesCount;
      Object.assign(existing, event, { _sources: [...sources], independentSourcesCount: count });
    }
  }
  return unique.map(({ _sources, ...event }) => event);
}
