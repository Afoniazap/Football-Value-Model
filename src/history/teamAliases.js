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
];

export function canonicalTeamName(value = "") {
  return String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|cf|afc|sc|ac|cd|fk|rc|ca|ud|club|sk|vv|kf)\b/g, " ")
    .replace(/[^a-z0-9а-яё]+/gi, " ").trim().replace(/\s+/g, " ");
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
