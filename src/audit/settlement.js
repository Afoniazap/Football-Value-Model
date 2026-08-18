const EPSILON = 1e-9;

function normalizeSelection(selection) {
  const value = String(selection || "").toLowerCase();
  if (["п1", "p1", "home", "h", "1"].includes(value)) return "home";
  if (["x", "draw", "d"].includes(value)) return "draw";
  if (["п2", "p2", "away", "a", "2"].includes(value)) return "away";
  if (value.startsWith("over")) return "over";
  if (value.startsWith("under")) return "under";
  return value;
}

function splitQuarterLine(line) {
  const value = Number(line);
  if (!Number.isFinite(value)) return [0, 0];
  const doubled = value * 2;
  if (Math.abs(doubled - Math.round(doubled)) < EPSILON) return [value, value];
  const lower = Math.floor(doubled) / 2;
  const upper = Math.ceil(doubled) / 2;
  return [lower, upper];
}

function gradeHalf(diff) {
  if (diff > EPSILON) return "WIN";
  if (diff < -EPSILON) return "LOSS";
  return "PUSH";
}

function combineHalfGrades(first, second) {
  if (first === second) return first;
  const grades = [first, second].sort().join("+");
  if (grades === "PUSH+WIN") return "HALF_WIN";
  if (grades === "LOSS+PUSH") return "HALF_LOSS";
  return "VOID";
}

export function grade1X2({ selection, homeGoals, awayGoals }) {
  const selected = normalizeSelection(selection);
  if (!["home", "draw", "away"].includes(selected)) return "UNSUPPORTED";
  const result = homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw";
  return selected === result ? "WIN" : "LOSS";
}

export function gradeOverUnder({ selection, line, homeGoals, awayGoals }) {
  const selected = normalizeSelection(selection);
  if (!["over", "under"].includes(selected)) return "UNSUPPORTED";
  const total = Number(homeGoals) + Number(awayGoals);
  if (!Number.isFinite(total)) return "UNSETTLED";
  const halves = splitQuarterLine(line);
  const grades = halves.map(part => {
    const diff = selected === "over" ? total - part : part - total;
    return gradeHalf(diff);
  });
  return combineHalfGrades(grades[0], grades[1]);
}

export function gradeAsianHandicap({ selection, line, homeGoals, awayGoals }) {
  const selected = normalizeSelection(selection);
  if (!["home", "away"].includes(selected)) return "UNSUPPORTED";
  if (!Number.isFinite(Number(homeGoals)) || !Number.isFinite(Number(awayGoals))) return "UNSETTLED";
  const rawDiff = selected === "home"
    ? Number(homeGoals) - Number(awayGoals)
    : Number(awayGoals) - Number(homeGoals);
  const halves = splitQuarterLine(line);
  const grades = halves.map(part => gradeHalf(rawDiff + part));
  return combineHalfGrades(grades[0], grades[1]);
}

export function gradeMarket({ market, selection, line, homeGoals, awayGoals }) {
  const key = String(market || "").toLowerCase();
  if (["h2h", "1x2"].includes(key)) return grade1X2({ selection, homeGoals, awayGoals });
  if (["ou", "over_under", "totals"].includes(key)) {
    return gradeOverUnder({ selection, line, homeGoals, awayGoals });
  }
  if (["ah", "asian_handicap", "spreads"].includes(key)) {
    return gradeAsianHandicap({ selection, line, homeGoals, awayGoals });
  }
  return "UNSUPPORTED";
}

export function fixedStakeProfitLoss(status, odds, stake = 1) {
  const price = Number(odds);
  if (!Number.isFinite(price) || price <= 1) return { stake, returns: 0, netUnits: 0, roi: null };
  if (status === "WIN") return { stake, returns: stake * price, netUnits: stake * (price - 1), roi: price - 1 };
  if (status === "LOSS") return { stake, returns: 0, netUnits: -stake, roi: -1 };
  if (status === "PUSH") return { stake, returns: stake, netUnits: 0, roi: 0 };
  if (status === "HALF_WIN") {
    const returns = (stake / 2) * price + (stake / 2);
    return { stake, returns, netUnits: returns - stake, roi: (returns - stake) / stake };
  }
  if (status === "HALF_LOSS") {
    const returns = stake / 2;
    return { stake, returns, netUnits: returns - stake, roi: (returns - stake) / stake };
  }
  return { stake: 0, returns: 0, netUnits: 0, roi: null };
}

export function settleSignal(signal, result, stake = 1) {
  if (!signal || !result) return null;
  const status = gradeMarket({
    market: signal.market,
    selection: signal.selection,
    line: signal.line,
    homeGoals: result.homeGoals,
    awayGoals: result.awayGoals
  });
  const accounting = fixedStakeProfitLoss(status, signal.officialOdds, stake);
  return {
    signalId: signal.signalId,
    fixtureId: signal.fixtureId,
    market: signal.market,
    selection: signal.selection,
    line: signal.line,
    status,
    homeGoals: result.homeGoals,
    awayGoals: result.awayGoals,
    result: result.result,
    ...accounting
  };
}
