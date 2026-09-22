import test from "node:test";
import assert from "node:assert/strict";
import { sameTeamIdentity, teamSearchAliases, canonicalTeamName, canonicalTeamIdentity } from "../src/history/teamAliases.js";

test("подтверждённые aliases учитывают диакритику и исторические названия", () => {
  assert.equal(sameTeamIdentity("Jagiellonia", "Jagiellonia Białystok"), true);
  assert.equal(sameTeamIdentity("Lillestrom", "Lillestrøm SK"), true);
  assert.equal(sameTeamIdentity("St. Truiden", "Sint-Truiden"), true);
  assert.equal(sameTeamIdentity("Aarhus", "AGF Aarhus"), true);
  assert.equal(sameTeamIdentity("Plzen", "Viktoria Plzeň"), true);
  assert.equal(sameTeamIdentity("Kairat Almaty", "FK Kairat"), true);
  assert.equal(sameTeamIdentity("Benfica", "Sport Lisboa e Benfica"), true);
  assert.equal(sameTeamIdentity("Ferencvarosi TC", "Ferencváros"), true);
});

test("alias registry не принимает youth и соседние клубы", () => {
  assert.equal(sameTeamIdentity("Jagiellonia", "Jagiellonia U19"), false);
  assert.equal(sameTeamIdentity("Aarhus", "Aarhus Fremad"), false);
  assert.equal(sameTeamIdentity("Aarhus", "ASA Aarhus"), false);
});

test("поиск TheSportsDB получает только подтверждённые варианты", () => {
  assert.ok(teamSearchAliases("Mjallby AIF").includes("Mjällby AIF"));
});

// Forensic audit: 22 pending predictions had a real result already present
// in SQLite under Football-Data's full legal name, but sameTeamIdentity
// rejected the short/common name from fixture-discovery. Each pair below is
// a confirmed case (exact kickoff, exact score, same fixture) from that
// audit — see the curated TEAM_ALIAS_GROUPS entries added alongside this test.
test("season-scoped backfill alias-gap: короткое имя прогноза сопоставляется с полным юридическим именем Football-Data (22 подтверждённых случая)",()=>{
  const pairs=[
    ["Celta Vigo","RC Celta de Vigo"],["Osasuna","CA Osasuna"],
    ["Lecce","US Lecce"],["Atalanta","Atalanta BC"],["Bologna","Bologna FC 1909"],
    ["Benfica","Sport Lisboa e Benfica"],["Estoril","GD Estoril Praia"],
    ["SC Braga","Sporting Clube de Braga"],["Vitória SC","Vitória SC"],
    ["Barcelona","FC Barcelona"],["Rayo Vallecano","Rayo Vallecano de Madrid"],
    ["Genoa","Genoa CFC"],["Como","Como 1907"],
    ["Ipswich","Ipswich Town FC"],["Liverpool","Liverpool FC"],
    ["Paris Saint Germain","Paris Saint-Germain FC"],["Monaco","AS Monaco FC"],
    ["Groningen","FC Groningen"],["Twente","FC Twente '65"],
    ["Telstar","Telstar 1963"],["Cambuur","SC Cambuur-Leeuwarden"],
    ["Frosinone","Frosinone Calcio"],["Venezia","Venezia FC"],
    ["Parma","Parma Calcio 1913"],["Monza","AC Monza"],
    ["Hamburger SV","Hamburger SV"],["FSV Mainz 05","1. FSV Mainz 05"],
    ["Sassuolo","US Sassuolo Calcio"],
    ["Alaves","Deportivo Alavés"],["Espanyol","RCD Espanyol de Barcelona"],["Sevilla","Sevilla FC"],
    ["GIL Vicente","Gil Vicente FC"],["Academico Viseu","Académico de Viseu FC"],
    ["Derby","Derby County FC"],["West Brom","West Bromwich Albion FC"],
    ["Norwich","Norwich City FC"],["Birmingham","Birmingham City FC"],
    ["Atletico Madrid","Club Atlético de Madrid"]
  ];
  for (const [prediction,sqlite] of pairs)
    assert.equal(sameTeamIdentity(prediction,sqlite),true,`${prediction} <-> ${sqlite}`);
});

// Explicitly named regression cases from the task specification, verbatim.
test("Sassuolo <-> US Sassuolo Calcio",()=>{assert.equal(sameTeamIdentity("Sassuolo","US Sassuolo Calcio"),true);});
test("Celta Vigo <-> RC Celta de Vigo",()=>{assert.equal(sameTeamIdentity("Celta Vigo","RC Celta de Vigo"),true);});
test("Osasuna <-> CA Osasuna",()=>{assert.equal(sameTeamIdentity("Osasuna","CA Osasuna"),true);});
test("Atletico Madrid <-> Club Atlético de Madrid",()=>{assert.equal(sameTeamIdentity("Atletico Madrid","Club Atlético de Madrid"),true);});
test("FSV Mainz 05 <-> 1. FSV Mainz 05",()=>{assert.equal(sameTeamIdentity("FSV Mainz 05","1. FSV Mainz 05"),true);});
test("SC Braga <-> Sporting Clube de Braga",()=>{assert.equal(sameTeamIdentity("SC Braga","Sporting Clube de Braga"),true);});

// Confirmed collision (forensic audit): the generic suffix-strip would
// otherwise merge Brazil's Vitória (Série A) with Portugal's Vitória SC
// (Vitória Guimarães, Primeira Liga) into the same "vitoria" canonical key.
test("Vitória (Бразилия) НЕ совпадает с Vitória SC (Португалия)",()=>{
  assert.equal(sameTeamIdentity("Vitória","Vitória SC"),false);
  assert.equal(sameTeamIdentity("Vitoria","Vitória SC"),false,"the unaccented Brazilian spelling must not collide either");
  assert.equal(sameTeamIdentity("EC Vitória","Vitória SC"),false);
  assert.notEqual(canonicalTeamName("Vitória"),canonicalTeamName("Vitória SC"));
});
test("Vitória (Бразилия, с ударением) всё ещё совпадает с Vitoria (без ударения) — тот же клуб",()=>{
  assert.equal(sameTeamIdentity("Vitória","Vitoria"),true);
});
test("Vitória SC совпадает сам с собой (одна и та же запись с двух сторон)",()=>{
  assert.equal(sameTeamIdentity("Vitória SC","Vitória SC"),true);
});

// Guard against the exact failure mode Stage A proved dangerous: adding the
// 26 curated aliases must not create ANY new raw-canonical collision for
// unrelated short names that happen to share a token with one of them.
test("новые alias-записи не расширяют совпадение на несвязанные команды с похожим именем",()=>{
  assert.equal(sameTeamIdentity("Osasuna","Osasuna B"),false);
  assert.equal(sameTeamIdentity("Bologna","Bologna Primavera"),false);
  assert.equal(sameTeamIdentity("Parma","Parma Clima"),false);
  assert.equal(sameTeamIdentity("Norwich","Norwich United"),false);
  assert.equal(sameTeamIdentity("Derby","Derby (Bermuda)"),false);
});

// Second targeted-recovery round (UEFA CL, Championship, Brazilian Série A
// via Football-Data's BSA code, CONMEBOL Libertadores via CLI, 2 more
// Ligue 1 pairs already present in previously-downloaded FL1 data) — 20
// pending predictions confirmed to already have a real result in SQLite
// under Football-Data's full legal/local name.
test("targeted recovery round 2: короткое имя прогноза сопоставляется с полным именем провайдера (18 подтверждённых пар)",()=>{
  const pairs=[
    ["Feyenoord","Feyenoord Rotterdam"],["Napoli","SSC Napoli"],["Sporting CP","Sporting Clube de Portugal"],
    ["Remo","Clube do Remo"],["Coritiba","Coritiba FBC"],["Flamengo","CR Flamengo"],
    ["Botafogo","Botafogo FR"],["Palmeiras","SE Palmeiras"],["Marseille","Olympique de Marseille"],
    ["QPR","Queens Park Rangers FC"],["Charlton","Charlton Athletic FC"],["Cruzeiro","Cruzeiro EC"],["Atletico Paranaense","CA Paranaense"],
    ["Corinthians","SC Corinthians Paulista"],["Chapecoense-sc","Chapecoense AF"],["Gremio","Grêmio FBPA"],
    ["Angers","Angers SCO"],["Rennes","Stade Rennais FC 1901"]
  ];
  for (const [prediction,provider] of pairs)
    assert.equal(sameTeamIdentity(prediction,provider),true,`${prediction} <-> ${provider}`);
});
test("Charlton <-> Charlton Athletic FC",()=>{assert.equal(sameTeamIdentity("Charlton","Charlton Athletic FC"),true);});

// Explicitly named regression cases from the task specification, verbatim.
test("Palmeiras <-> SE Palmeiras",()=>{assert.equal(sameTeamIdentity("Palmeiras","SE Palmeiras"),true);});
test("Feyenoord <-> Feyenoord Rotterdam",()=>{assert.equal(sameTeamIdentity("Feyenoord","Feyenoord Rotterdam"),true);});
test("Napoli <-> SSC Napoli",()=>{assert.equal(sameTeamIdentity("Napoli","SSC Napoli"),true);});
test("Sporting CP <-> Sporting Clube de Portugal",()=>{assert.equal(sameTeamIdentity("Sporting CP","Sporting Clube de Portugal"),true);});
test("Angers <-> Angers SCO",()=>{assert.equal(sameTeamIdentity("Angers","Angers SCO"),true);});
test("Rennes <-> Stade Rennais FC 1901",()=>{assert.equal(sameTeamIdentity("Rennes","Stade Rennais FC 1901"),true);});
test("Marseille <-> Olympique de Marseille",()=>{assert.equal(sameTeamIdentity("Marseille","Olympique de Marseille"),true);});

// Negative tests: near-neighbour / reserve / unrelated teams sharing a token
// with a newly-added alias must NOT collapse into it.
test("round 2 aliases не расширяют совпадение на несвязанные/похожие команды",()=>{
  assert.equal(sameTeamIdentity("Corinthians","Corinthians U17"),false);
  assert.equal(sameTeamIdentity("Corinthians","Corinthians W"),false);
  assert.equal(sameTeamIdentity("Rennes","Rennes B"),false);
  assert.equal(sameTeamIdentity("Angers","Angers B"),false);
  assert.equal(sameTeamIdentity("Napoli","Napoli Primavera"),false);
  assert.equal(sameTeamIdentity("Flamengo","Flamengo U20"),false);
  assert.equal(sameTeamIdentity("QPR","Queens Park FC"),false,"a different club (Queen's Park, Scotland) must not match QPR");
  assert.equal(sameTeamIdentity("Charlton","Bermondsey Charlton"),false);
});

// Third targeted-recovery round (Shadow V3 Phase 1 identity forensic audit):
// insertRow() stores canonicalTeamName(raw) without alias resolution, so a
// club shows up under two different literal SQLite strings across import
// batches/providers even though this table already recognizes them as one
// team for query purposes. Confirmed via research/shadowV3/_identity_audit*.mjs
// (read-only, full-corpus collision check, zero SQLite rows changed).
test("round 3 (identity forensic audit): исторически известные клубы, разошедшиеся написанием между backfill и live-харвестом 2026/27",()=>{
  const pairs=[
    ["Angers","Angers SCO"],["Como","Como 1907"],["Ipswich","Ipswich Town FC"],
    ["Real Betis","Real Betis Balompié"],["Real Sociedad","Real Sociedad de Fútbol"],
    ["Newcastle","Newcastle United FC"],["Leeds","Leeds United FC"],
    ["Fiorentina","ACF Fiorentina"],["Udinese","Udinese Calcio"],["Cagliari","Cagliari Calcio"],["Lazio","SS Lazio"],
    ["Nice","OGC Nice"],["Strasbourg","RC Strasbourg Alsace"],["Auxerre","AJ Auxerre"],["Lille","Lille OSC"],
    ["1899 Hoffenheim","TSG 1899 Hoffenheim"],["Bayer Leverkusen","Bayer 04 Leverkusen"],
    ["Union Berlin","1. FC Union Berlin"],["Werder Bremen","SV Werder Bremen"],
    ["Tottenham","Tottenham Hotspur FC"],["Lens","Racing Club de Lens"],
    ["Brighton","Brighton & Hove Albion FC"],["Inter","FC Internazionale Milano"],["Lyon","Olympique Lyonnais"]
  ];
  for (const [a,b] of pairs) assert.equal(sameTeamIdentity(a,b),true,`${a} <-> ${b}`);
});

test("round 3: within-live-season spelling splits для только что повышенных клубов",()=>{
  assert.equal(sameTeamIdentity("Racing Santander","Real Racing Club de Santander"),true);
  assert.equal(sameTeamIdentity("Coventry","Coventry City FC"),true);
  assert.equal(sameTeamIdentity("Coventry","Coventry City"),true);
  assert.equal(sameTeamIdentity("Estac Troyes","ES Troyes AC"),true,"extends the existing Troyes group, not a new one");
  assert.equal(sameTeamIdentity("Estac Troyes","Troyes"),true);
  assert.equal(sameTeamIdentity("SV Elversberg","SV 07 Elversberg"),true,"extends the existing Elversberg group, not a new one");
  assert.equal(sameTeamIdentity("SV Elversberg","Elversberg"),true);
});

test("round 3 aliases не расширяют совпадение на несвязанные/похожие команды",()=>{
  assert.equal(sameTeamIdentity("Inter","Inter Miami"),false,"a different club on a different continent must not collapse into Inter Milan");
  assert.equal(sameTeamIdentity("Inter","Internacional"),false,"Brazil's Internacional (sometimes shortened Inter) must not collapse into Inter Milan");
  assert.equal(sameTeamIdentity("Union Berlin","Union Saint-Gilloise"),false);
  assert.equal(sameTeamIdentity("Real Betis","Real Betis B"),false);
  assert.equal(sameTeamIdentity("Leeds","Leeds United Women"),false);
  assert.equal(sameTeamIdentity("Brighton","Brighton Deportivo"),false);
  assert.equal(sameTeamIdentity("Newcastle","Newcastle Jets"),false,"a different club (A-League, Australia) sharing only the city name");
  assert.equal(sameTeamIdentity("Coventry","Coventry Sphinx"),false);
});

test("canonicalTeamIdentity: резолвит уже нормализованную строку из SQLite (homeTeamNormalized/awayTeamNormalized) к единому ключу группы",()=>{
  assert.equal(canonicalTeamIdentity(canonicalTeamName("Angers")),canonicalTeamIdentity(canonicalTeamName("Angers SCO")));
  assert.equal(canonicalTeamIdentity(canonicalTeamName("Racing Santander")),canonicalTeamIdentity(canonicalTeamName("Real Racing Club de Santander")));
  assert.equal(canonicalTeamIdentity(canonicalTeamName("Inter")),canonicalTeamIdentity(canonicalTeamName("FC Internazionale Milano")));
});

test("canonicalTeamIdentity: команда без alias-группы просто проходит через canonicalTeamName без изменений",()=>{
  assert.equal(canonicalTeamIdentity("Malaga"),canonicalTeamName("Malaga"));
  assert.equal(canonicalTeamIdentity(canonicalTeamName("Hull City")),canonicalTeamName("Hull City"));
});

// Safety-review requirement: canonicalTeamIdentity must not be a second,
// independent identity semantics -- it is a pure repackaging of the SAME
// group-membership logic sameTeamIdentity already uses (both call the same
// internal groupFor()). This asserts that equivalence directly: for any
// pair, the two functions must agree, in both directions, with zero drift.
test("canonicalTeamIdentity и sameTeamIdentity согласованы: одна и та же группировка, два разных API",()=>{
  const allPairs=[
    ["Angers","Angers SCO"],["Como","Como 1907"],["Racing Santander","Real Racing Club de Santander"],
    ["Inter","FC Internazionale Milano"],["Coventry","Coventry City FC"],["Estac Troyes","ES Troyes AC"],
    ["SV Elversberg","SV 07 Elversberg"],["Tottenham","Tottenham Hotspur FC"],["Malaga","Malaga"]
  ];
  for (const [a,b] of allPairs)
    assert.equal(canonicalTeamIdentity(a)===canonicalTeamIdentity(b),sameTeamIdentity(a,b),`${a} <-> ${b}`);
  const negativePairs=[
    ["Inter","Inter Miami"],["Union Berlin","Union Saint-Gilloise"],["Real Betis","Real Betis B"],
    ["Osasuna","Osasuna B"],["Vitória","Vitória SC"]
  ];
  for (const [a,b] of negativePairs)
    assert.equal(canonicalTeamIdentity(a)===canonicalTeamIdentity(b),sameTeamIdentity(a,b),`${a} <-> ${b} (must both be false)`);
});
