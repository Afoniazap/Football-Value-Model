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
  ,{ name: "Paderborn", aliases: ["SC Paderborn 07"], evidence: { source: "THESPORTSDB", teamId: "134551" } }
  ,{ name: "Elversberg", aliases: ["SV 07 Elversberg"], evidence: { source: "THESPORTSDB", teamId: "138411" } }
  ,{ name: "Excelsior", aliases: ["SBV Excelsior"], evidence: { source: "THESPORTSDB", teamId: "133757" } }
  ,{ name: "AZ Alkmaar", aliases: ["AZ"], evidence: { source: "THESPORTSDB", teamId: "133767" } }
  ,{ name: "Maritimo", aliases: ["Marítimo", "CS Marítimo"], evidence: { source: "THESPORTSDB", teamId: "134023" } }
  ,{ name: "Troyes", aliases: ["ES Troyes AC"], evidence: { source: "THESPORTSDB", teamId: "134789" } }
  ,{ name: "Atletico Mineiro", aliases: ["Atlético Mineiro", "CA Mineiro"], evidence: { source: "THESPORTSDB", teamId: "134299" } }
  ,{ name: "Sao Paulo", aliases: ["São Paulo", "São Paulo FC"], evidence: { source: "THESPORTSDB", teamId: "134291" } }
  ,{ name: "Bragantino", aliases: ["Red Bull Bragantino", "RB Bragantino"], evidence: { source: "THESPORTSDB", teamId: "134736" } }
  ,{ name: "NEC Nijmegen", aliases: ["NEC"], evidence: { source: "THESPORTSDB", teamId: "133760" } }
];

export function canonicalTeamName(value = "") {
  const cleaned=String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яё]+/gi, " ").trim().replace(/\s+/g, " ");
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
