import { EMPTY_TELEGRAM_PERFORMANCE } from "./telegramRegistry.js";

export function calculateTelegramPerformance(records = []) {
  const picks = records.filter(record => record?.pick);
  const graded = picks.filter(record => record.independentlyVerified === true && ["WIN", "LOSS", "PUSH"].includes(record.outcome));
  const wins = graded.filter(record => record.outcome === "WIN").length;
  const losses = graded.filter(record => record.outcome === "LOSS").length;
  const pushes = graded.filter(record => record.outcome === "PUSH").length;
  const settled = wins + losses;
  const odds = graded.map(record => Number(record.pick?.odds)).filter(value => Number.isFinite(value) && value > 1);
  const returns = graded.flatMap(record => {
    const price = Number(record.pick?.odds);
    if (record.outcome === "PUSH") return [0];
    if (record.outcome === "LOSS") return [-1];
    return Number.isFinite(price) && price > 1 ? [price - 1] : [];
  });
  const clvValues = graded.map(record => Number(record.clv)).filter(Number.isFinite);
  return {
    ...EMPTY_TELEGRAM_PERFORMANCE,
    picks: picks.length, gradedPicks: graded.length, wins, losses, pushes,
    hitRate: settled ? wins / settled : null,
    roi: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    avgOdds: odds.length ? odds.reduce((sum, value) => sum + value, 0) / odds.length : null,
    clv: clvValues.length ? clvValues.reduce((sum, value) => sum + value, 0) / clvValues.length : null,
    sampleSize: graded.length
  };
}
