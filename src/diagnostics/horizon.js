export function auditExactHorizon(fixtures = [], {
  now = new Date(),
  horizonHours = 24
} = {}) {
  const start = new Date(now);
  const end = new Date(start.getTime() + horizonHours * 3600_000);
  const accepted = [];
  const rejected = [];

  for (const fixture of fixtures) {
    const kickoff = new Date(fixture.utcDate || fixture.kickoff);
    const valid = Number.isFinite(kickoff.getTime()) && kickoff > start && kickoff <= end;
    if (valid) accepted.push(fixture);
    else rejected.push({
      fixtureId: fixture.id || fixture.fixtureId || null,
      code: "HORIZON_VIOLATION",
      kickoff: fixture.utcDate || fixture.kickoff || null
    });
  }

  const times = accepted.map(fixture => new Date(fixture.utcDate || fixture.kickoff).getTime()).filter(Number.isFinite);
  return {
    accepted,
    rejected,
    horizonStart: start.toISOString(),
    horizonEnd: end.toISOString(),
    earliestFixture: times.length ? new Date(Math.min(...times)).toISOString() : null,
    latestFixture: times.length ? new Date(Math.max(...times)).toISOString() : null,
    actualHorizonSpanHours: times.length ? (Math.max(...times) - Math.min(...times)) / 3600_000 : 0
  };
}
