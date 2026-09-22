// weight = exp(-ln(2) * ageDays / halfLife). ageDays is always relative to
// the fold's own cutoff, never Date.now() -- callers pass cutoffMs
// explicitly (see walkforward.js), never read the wall clock.
export function decayWeight(matchKickoffMs, cutoffMs, halfLifeDays) {
  const ageDays = (cutoffMs - matchKickoffMs) / 86400000;
  if (ageDays <= 0) throw new Error("decayWeight: match is not strictly before cutoff (leakage guard tripped)");
  return Math.exp(-Math.LN2 * ageDays / halfLifeDays);
}

export const HALF_LIFE_CANDIDATES = [60, 90, 120, 180, 270, 365];
