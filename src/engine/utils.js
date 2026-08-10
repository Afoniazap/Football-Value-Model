export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function poisson(k, lambda) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

export function buildScoreMatrix(lambdaHome, lambdaAway, maxGoals = 8) {
  const matrix = [];
  let covered = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisson(h, lambdaHome) * poisson(a, lambdaAway);
      matrix.push({ h, a, p });
      covered += p;
    }
  }
  return matrix.map(x => ({ ...x, p: x.p / covered }));
}

export function removeMarginThreeWay(home, draw, away) {
  const raws = [1 / home, 1 / draw, 1 / away];
  const sum = raws.reduce((a, b) => a + b, 0);
  return { home: raws[0] / sum, draw: raws[1] / sum, away: raws[2] / sum };
}

export function removeMarginTwoWay(a, b) {
  const ra = 1 / a;
  const rb = 1 / b;
  const sum = ra + rb;
  return [ra / sum, rb / sum];
}

export function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

export function standardDeviation(values) {
  const m = mean(values);
  if (m === null) return null;
  return Math.sqrt(mean(values.map(v => (v - m) ** 2)));
}

export function normalizeName(value = "") {
  return value.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/football|club|calcio|afc|fc|cf/g, "")
    .replace(/[^a-z0-9а-яё]/gi, "");
}

export function similarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.88;
  const bigrams = s => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ax = bigrams(x), by = bigrams(y);
  let common = 0;
  for (const item of ax) if (by.has(item)) common++;
  return (2 * common) / Math.max(1, ax.size + by.size);
}

export function localDate(iso) {
  return new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }) + " (Киев)";
}
