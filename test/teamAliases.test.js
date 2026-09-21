import test from "node:test";
import assert from "node:assert/strict";
import { sameTeamIdentity, teamSearchAliases, canonicalTeamName } from "../src/history/teamAliases.js";

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
