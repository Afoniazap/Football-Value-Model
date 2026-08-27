import test from "node:test";
import assert from "node:assert/strict";
import { sameTeamIdentity, teamSearchAliases } from "../src/history/teamAliases.js";

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
