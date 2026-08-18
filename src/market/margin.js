export function removeMargin(odds) {
  if (!odds) return null;
  const raw = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const total = raw.reduce((a, b) => a + b, 0);
  return {
    home: raw[0] / total,
    draw: raw[1] / total,
    away: raw[2] / total
  };
}
