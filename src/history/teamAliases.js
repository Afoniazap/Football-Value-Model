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
  ,{ name: "Elversberg", aliases: ["SV 07 Elversberg"], evidence: { source: "THESPORTSDB", teamId: "138411", historicalLeagues:[{id:"4399",season:"2025-2026",name:"German 2. Bundesliga"}] } }
  ,{ name: "Excelsior", aliases: ["SBV Excelsior"], evidence: { source: "THESPORTSDB", teamId: "133757" } }
  ,{ name: "AZ Alkmaar", aliases: ["AZ"], evidence: { source: "THESPORTSDB", teamId: "133767" } }
  ,{ name: "Maritimo", aliases: ["Marítimo", "CS Marítimo"], evidence: { source: "THESPORTSDB", teamId: "134023" } }
  ,{ name: "Troyes", aliases: ["ES Troyes AC"], evidence: { source: "THESPORTSDB", teamId: "134789", historicalLeagues:[{id:"4401",season:"2025-2026",name:"French Ligue 2"}] } }
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
