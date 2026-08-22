const aliases = new Map([
  ["olympique marseille", "marseille"], ["olympique de marseille", "marseille"],
  ["rc strasbourg alsace", "strasbourg"], ["strasbourg alsace", "strasbourg"]
]);

export function normalizeClubName(value) {
  const normalized = String(value || "").toLowerCase().normalize("NFKD")
    .replace(/\b(fc|cf|afc|sc|club|football|calcio)\b/g, " ")
    .replace(/[^a-z0-9а-яё]+/giu, " ").replace(/\s+/g, " ").trim();
  return aliases.get(normalized) || normalized;
}

function nameScore(left, right) {
  const a = normalizeClubName(left);
  const b = normalizeClubName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  return 0;
}

export function matchContextEventToFixture(event, fixtures = [], { maxHours = 36, minConfidence = 75 } = {}) {
  let best = null;
  for (const fixture of fixtures) {
    const direct = (nameScore(event.homeTeam, fixture.home) + nameScore(event.awayTeam, fixture.away)) / 2;
    const reversed = (nameScore(event.homeTeam, fixture.away) + nameScore(event.awayTeam, fixture.home)) / 2;
    const teams = Math.max(direct, reversed);
    if (!teams) continue;
    const eventTime = new Date(event.fixtureDate || event.kickoff || event.publishedAt).getTime();
    const fixtureTime = new Date(fixture.utcDate).getTime();
    const hours = Math.abs(eventTime - fixtureTime) / 3_600_000;
    const time = Number.isFinite(hours) ? Math.max(0, 1 - hours / maxHours) : 0.35;
    const competition = event.competition && fixture.competitionCode
      ? (String(event.competition).toLowerCase().includes(String(fixture.competitionCode).toLowerCase()) ? 1 : 0.5)
      : 0.5;
    const confidence = Math.round((teams * 0.7 + time * 0.2 + competition * 0.1) * 100);
    if (!best || confidence > best.confidence) best = { fixture, confidence, reversed: reversed > direct };
  }
  return best?.confidence >= minConfidence ? best : null;
}
