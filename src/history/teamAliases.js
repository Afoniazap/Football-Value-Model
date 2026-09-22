export const TEAM_ALIAS_GROUPS = [
  { name: "Ararat-Armenia", aliases: ["Ararat Armenia", "FC Ararat-Armenia"], evidence: { source: "THESPORTSDB", teamId: "137892" } },
  { name: "Jagiellonia", aliases: ["Jagiellonia Białystok", "Jagiellonia Bialystok"], evidence: { source: "THESPORTSDB", teamId: "135297" } },
  { name: "Lillestrom", aliases: ["Lillestrøm", "Lillestrøm SK", "Lillestrom SK"], evidence: { source: "THESPORTSDB", teamId: "134569", historicalLeagues: [{ id:"4457", season:"2025", name:"Norwegian 1. Divisjon" }] } },
  { name: "Egnatia Rrogozhinë", aliases: ["Egnatia", "KF Egnatia", "KF Egnatia Rrogozhine"], evidence: { source: "THESPORTSDB", teamId: "140667" } },
  { name: "St. Truiden", aliases: ["St.Truiden", "Sint-Truiden", "Sint-Truidense VV", "STVV"], evidence: { source: "THESPORTSDB", teamId: "135461" } },
  { name: "Mjallby AIF", aliases: ["Mjällby", "Mjällby AIF", "Mjällby Allmänna Idrottsförening"], evidence: { source: "THESPORTSDB", teamId: "134164" } },
  { name: "Aarhus", aliases: ["AGF Aarhus"], evidence: { source: "THESPORTSDB", teamId: "133899" } },
  { name: "Plzen", aliases: ["Viktoria Plzen", "Viktoria Plzeň", "FC Viktoria Plzen"], evidence: { source: "THESPORTSDB", teamId: "134015" } },
  { name: "Kairat Almaty", aliases: ["FK Kairat"], evidence: { source: "THESPORTSDB", teamId: "134602" } },
  { name: "Benfica", aliases: ["Sport Lisboa e Benfica", "SL Benfica"], evidence: { source: "THESPORTSDB", teamId: "134108" } },
  { name: "Ferencvarosi TC", aliases: ["Ferencvaros", "Ferencváros", "Ferencvárosi TC"], evidence: { source: "THESPORTSDB", teamId: "134620" } }
  ,{ name: "Swansea City", aliases: ["Swansea City AFC"], evidence: { source: "THESPORTSDB", teamId: "133614" } }
  ,{ name: "Hull City", aliases: ["Hull City AFC"], evidence: { source: "THESPORTSDB", teamId: "133617" } }
  ,{ name: "Paderborn", aliases: ["SC Paderborn 07"], evidence: { source: "THESPORTSDB", teamId: "134551", historicalLeagues:[{id:"4399",season:"2025-2026",name:"German 2. Bundesliga"}] } }
  ,{ name: "Elversberg", aliases: ["SV 07 Elversberg", "SV Elversberg"], evidence: { source: "THESPORTSDB", teamId: "138411", historicalLeagues:[{id:"4399",season:"2025-2026",name:"German 2. Bundesliga"}] } }
  ,{ name: "Excelsior", aliases: ["SBV Excelsior"], evidence: { source: "THESPORTSDB", teamId: "133757" } }
  ,{ name: "AZ Alkmaar", aliases: ["AZ"], evidence: { source: "THESPORTSDB", teamId: "133767" } }
  ,{ name: "Maritimo", aliases: ["Marítimo", "CS Marítimo"], evidence: { source: "THESPORTSDB", teamId: "134023" } }
  ,{ name: "Troyes", aliases: ["ES Troyes AC", "Estac Troyes"], evidence: { source: "THESPORTSDB", teamId: "134789", historicalLeagues:[{id:"4401",season:"2025-2026",name:"French Ligue 2"}] } }
  ,{ name: "Atletico Mineiro", aliases: ["Atlético Mineiro", "CA Mineiro"], evidence: { source: "THESPORTSDB", teamId: "134299" } }
  ,{ name: "Sao Paulo", aliases: ["São Paulo", "São Paulo FC"], evidence: { source: "THESPORTSDB", teamId: "134291" } }
  ,{ name: "Bragantino", aliases: ["Red Bull Bragantino", "RB Bragantino"], evidence: { source: "THESPORTSDB", teamId: "134736" } }
  ,{ name: "NEC Nijmegen", aliases: ["NEC"], evidence: { source: "THESPORTSDB", teamId: "133760" } }
  // Forensic audit (22 alias-gap pending predictions, season-scoped backfill
  // task): Football-Data's season endpoint returns full legal club names
  // ("US Sassuolo Calcio", "Sporting Clube de Braga", "1. FSV Mainz 05"...)
  // while fixture-discovery stores the short/common name ("Sassuolo",
  // "SC Braga", "FSV Mainz 05"). The generic suffix-strip below only covers
  // a narrow, safe set of single-word legal-form tokens (fc/cf/afc/sc/...) —
  // confirmed (Stage A collision test against the full 16k-row SQLite corpus)
  // that widening it to cover these longer forms (US, Calcio, Clube,
  // Deportivo, Club, RCD, County, City, Town, year suffixes like "1909")
  // creates real cross-club collisions elsewhere ("Nacional" alone merges
  // 4+ distinct clubs from Uruguay/Portugal/Ecuador/Colombia; "Athletic"
  // merges Athletic Bilbao with a dozen unrelated lower-league "X Athletic"
  // sides). Curated, per-club exact pairs — the same mechanism already used
  // above for THESPORTSDB-sourced ambiguity — carries none of that risk.
  ,{ name: "Celta Vigo", aliases: ["RC Celta de Vigo"] }
  ,{ name: "Lecce", aliases: ["US Lecce"] }
  ,{ name: "Atalanta", aliases: ["Atalanta BC"] }
  ,{ name: "Bologna", aliases: ["Bologna FC 1909"] }
  ,{ name: "Estoril", aliases: ["GD Estoril Praia"] }
  ,{ name: "SC Braga", aliases: ["Sporting Clube de Braga"] }
  ,{ name: "Rayo Vallecano", aliases: ["Rayo Vallecano de Madrid"] }
  ,{ name: "Genoa", aliases: ["Genoa CFC"] }
  ,{ name: "Como", aliases: ["Como 1907"] }
  ,{ name: "Ipswich", aliases: ["Ipswich Town FC"] }
  ,{ name: "Monaco", aliases: ["AS Monaco FC"] }
  ,{ name: "Twente", aliases: ["FC Twente '65"] }
  ,{ name: "Telstar", aliases: ["Telstar 1963"] }
  ,{ name: "Cambuur", aliases: ["SC Cambuur-Leeuwarden"] }
  ,{ name: "Frosinone", aliases: ["Frosinone Calcio"] }
  ,{ name: "Parma", aliases: ["Parma Calcio 1913"] }
  ,{ name: "FSV Mainz 05", aliases: ["1. FSV Mainz 05"] }
  ,{ name: "Sassuolo", aliases: ["US Sassuolo Calcio"] }
  ,{ name: "Alaves", aliases: ["Deportivo Alavés"] }
  ,{ name: "Espanyol", aliases: ["RCD Espanyol de Barcelona"] }
  ,{ name: "Academico Viseu", aliases: ["Académico de Viseu FC"] }
  ,{ name: "Derby", aliases: ["Derby County FC"] }
  ,{ name: "West Brom", aliases: ["West Bromwich Albion FC"] }
  ,{ name: "Norwich", aliases: ["Norwich City FC"] }
  ,{ name: "Birmingham", aliases: ["Birmingham City FC"] }
  ,{ name: "Atletico Madrid", aliases: ["Club Atlético de Madrid"] }
  // Second targeted-recovery round (UEFA CL, Championship, Brazilian Série A
  // via Football-Data's BSA code, CONMEBOL Libertadores via CLI, and 2 more
  // Ligue 1 pairs already present in previously-downloaded FL1 data) — same
  // verification as the first round: each pair checked individually against
  // the full SQLite corpus, zero new collisions.
  ,{ name: "Feyenoord", aliases: ["Feyenoord Rotterdam"] }
  ,{ name: "Napoli", aliases: ["SSC Napoli"] }
  ,{ name: "Sporting CP", aliases: ["Sporting Clube de Portugal"] }
  ,{ name: "QPR", aliases: ["Queens Park Rangers FC"] }
  ,{ name: "Charlton", aliases: ["Charlton Athletic FC"] }
  ,{ name: "Remo", aliases: ["Clube do Remo"] }
  ,{ name: "Coritiba", aliases: ["Coritiba FBC"] }
  ,{ name: "Cruzeiro", aliases: ["Cruzeiro EC"] }
  ,{ name: "Atletico Paranaense", aliases: ["CA Paranaense"] }
  ,{ name: "Flamengo", aliases: ["CR Flamengo"] }
  ,{ name: "Botafogo", aliases: ["Botafogo FR"] }
  ,{ name: "Palmeiras", aliases: ["SE Palmeiras"] }
  ,{ name: "Corinthians", aliases: ["SC Corinthians Paulista"] }
  ,{ name: "Chapecoense-sc", aliases: ["Chapecoense AF"] }
  ,{ name: "Gremio", aliases: ["Grêmio FBPA"] }
  ,{ name: "Angers", aliases: ["Angers SCO"] }
  ,{ name: "Rennes", aliases: ["Stade Rennais FC 1901"] }
  ,{ name: "Marseille", aliases: ["Olympique de Marseille"] }
  // Third targeted-recovery round (Shadow V3 Phase 1 identity forensic
  // audit): insertRow() stores canonicalTeamName(raw) directly without
  // alias resolution, so two literal spellings of the same club end up as
  // two different homeTeamNormalized/awayTeamNormalized strings in SQLite
  // even when this table already recognizes them as one team via
  // sameTeamIdentity. These 21 pairs were confirmed with a read-only,
  // full-SQLite-corpus check (every competitionCode/source, not just the
  // 5 Shadow V3 leagues; zero rows changed): each key set maps to exactly
  // the 2-3 raw spellings of ONE real club, with no collision with any
  // unrelated club (see the negative-match tests below and in
  // test/teamAliases.test.js "round 3 aliases не расширяют совпадение...").
  ,{ name: "Real Betis", aliases: ["Real Betis Balompié"] }
  ,{ name: "Real Sociedad", aliases: ["Real Sociedad de Fútbol"] }
  ,{ name: "Newcastle", aliases: ["Newcastle United FC", "Newcastle United"] }
  ,{ name: "Leeds", aliases: ["Leeds United FC", "Leeds United"] }
  ,{ name: "Fiorentina", aliases: ["ACF Fiorentina"] }
  ,{ name: "Udinese", aliases: ["Udinese Calcio"] }
  ,{ name: "Cagliari", aliases: ["Cagliari Calcio"] }
  ,{ name: "Lazio", aliases: ["SS Lazio"] }
  ,{ name: "Nice", aliases: ["OGC Nice"] }
  ,{ name: "Strasbourg", aliases: ["RC Strasbourg Alsace"] }
  ,{ name: "Auxerre", aliases: ["AJ Auxerre"] }
  ,{ name: "Lille", aliases: ["Lille OSC"] }
  ,{ name: "1899 Hoffenheim", aliases: ["TSG 1899 Hoffenheim"] }
  ,{ name: "Bayer Leverkusen", aliases: ["Bayer 04 Leverkusen"] }
  ,{ name: "Union Berlin", aliases: ["1. FC Union Berlin"] }
  ,{ name: "Werder Bremen", aliases: ["SV Werder Bremen"] }
  ,{ name: "Tottenham", aliases: ["Tottenham Hotspur FC", "Tottenham Hotspur"] }
  ,{ name: "Lens", aliases: ["Racing Club de Lens"] }
  ,{ name: "Brighton", aliases: ["Brighton & Hove Albion FC"] }
  ,{ name: "Inter", aliases: ["FC Internazionale Milano"] }
  ,{ name: "Lyon", aliases: ["Olympique Lyonnais"] }
  // Within-2026/27-live-season spelling splits: two providers disagree on
  // the form of a newly-promoted club's name within the SAME season (not a
  // historical-vs-live mismatch) -- still must collapse to one identity or
  // the club looks like two different opponents in its own debut season.
  ,{ name: "Racing Santander", aliases: ["Real Racing Club de Santander"] }
  ,{ name: "Coventry", aliases: ["Coventry City FC", "Coventry City"] }
];

// Confirmed collision (forensic audit): the generic suffix-strip below would
// otherwise reduce "Vitória SC" (Vitória Guimarães, Portugal, Primeira Liga)
// to the same "vitoria" key as Brazil's "Vitória"/"EC Vitória" (Série A) —
// two entirely different clubs on two different continents. A narrow,
// explicit exception for this one confirmed string, not a change to the
// general rule (which stays correct for every other "X SC" club).
const KEEP_FULL_FORM = new Set(["vitoria sc"]);

export function canonicalTeamName(value = "") {
  const cleaned=String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яё]+/gi, " ").trim().replace(/\s+/g, " ");
  if (KEEP_FULL_FORM.has(cleaned)) return cleaned;
  const withoutClubSuffix=cleaned.replace(/\b(fc|cf|afc|sc|ac|cd|fk|rc|ca|ud|club|sk|vv|kf)\b/g, " ").trim().replace(/\s+/g, " ");
  // Для коротких названий суффикс является частью identity: NEC (Нидерланды)
  // и NEC FC (Уганда) не должны объединяться в одну команду.
  return withoutClubSuffix.replace(/\s/g,"").length<=3?cleaned:withoutClubSuffix;
}

const GROUP_BY_CANONICAL=new Map(TEAM_ALIAS_GROUPS.flatMap(group=>[group.name,...group.aliases].map(alias=>[canonicalTeamName(alias),group])));

function groupFor(value) {
  const normalized = canonicalTeamName(value);
  return GROUP_BY_CANONICAL.get(normalized)||null;
}

export function sameTeamIdentity(left, right) {
  const a = canonicalTeamName(left), b = canonicalTeamName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const leftGroup = groupFor(left), rightGroup = groupFor(right);
  return Boolean(leftGroup && rightGroup && leftGroup.name === rightGroup.name);
}

export function teamSearchAliases(value) {
  const group = groupFor(value);
  return group ? [...new Set([value, group.name, ...group.aliases])] : [value];
}

export function teamIdentityEvidence(value) {
  return groupFor(value)?.evidence || null;
}

// insertRow() (src/history/sqliteHistory.js) stores canonicalTeamName(raw)
// directly, never alias-resolved -- so two literal spellings of the same
// club can end up as two different homeTeamNormalized/awayTeamNormalized
// strings in SQLite even when this table already knows they're one team.
// canonicalTeamIdentity() is the alias-aware read-time resolver for callers
// that need a SINGLE stable key per team (e.g. building a team index from
// raw SQLite rows): it returns the alias group's own canonical name when
// one exists, else falls back to plain canonicalTeamName(). Existing
// query-time consumers (teamWhere/sameTeamIdentity/teamSearchAliases) are
// unaffected -- this is a new, additive export.
export function canonicalTeamIdentity(value) {
  const group = groupFor(value);
  return group ? canonicalTeamName(group.name) : canonicalTeamName(value);
}
