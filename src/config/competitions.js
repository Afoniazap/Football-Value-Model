export const THE_ODDS_API_SPORT_KEYS = Object.freeze({
  PL: "soccer_epl",
  PD: "soccer_spain_la_liga",
  BL1: "soccer_germany_bundesliga",
  SA: "soccer_italy_serie_a",
  FL1: "soccer_france_ligue_one",
  CL: "soccer_uefa_champs_league",
  CLI: "soccer_conmebol_copa_libertadores",
  EL: "soccer_uefa_europa_league",
  DED: "soccer_netherlands_eredivisie",
  PPL: "soccer_portugal_primeira_liga",
  ELC: "soccer_efl_champ",
  BSA: "soccer_brazil_campeonato"
});

export const ODDS_API_IO_LEAGUE_SLUGS = Object.freeze({
  PL: "england-premier-league",
  PD: "spain-la-liga",
  BL1: "germany-bundesliga",
  SA: "italy-serie-a",
  FL1: "france-ligue-1",
  CL: "uefa-champions-league"
});

export const API_FOOTBALL_LEAGUE_IDS = Object.freeze({
  PL: 39,
  PD: 140,
  BL1: 78,
  SA: 135,
  FL1: 61
});

export function competitionMarketSupport(code) {
  return {
    code,
    primary: Boolean(THE_ODDS_API_SPORT_KEYS[code]),
    oddsApiIo: Boolean(ODDS_API_IO_LEAGUE_SLUGS[code]),
    apiFootballOdds: Boolean(API_FOOTBALL_LEAGUE_IDS[code])
  };
}

export function marketSupportClass(code) {
  const support = competitionMarketSupport(code);
  const primary = support.primary;
  const secondary = support.oddsApiIo || support.apiFootballOdds;
  if (primary && secondary) return "SUPPORTED_BOTH";
  if (primary) return "SUPPORTED_PRIMARY";
  if (secondary) return "SUPPORTED_SECONDARY";
  return "UNSUPPORTED";
}

export function auditCompetitionCoverage(fixtures = []) {
  const byCode = new Map();
  for (const fixture of fixtures) {
    const code = fixture.competitionCode || "UNKNOWN";
    byCode.set(code, (byCode.get(code) || 0) + 1);
  }
  const rows = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => ({
      code,
      count,
      support: marketSupportClass(code),
      providers: competitionMarketSupport(code)
    }));
  return {
    rows,
    supported: rows.filter(row => row.support !== "UNSUPPORTED").reduce((sum, row) => sum + row.count, 0),
    unsupported: rows.filter(row => row.support === "UNSUPPORTED").reduce((sum, row) => sum + row.count, 0),
    total: fixtures.length,
    unsupportedTop: rows.filter(row => row.support === "UNSUPPORTED").slice(0, 10)
  };
}
