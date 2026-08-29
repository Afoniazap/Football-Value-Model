import test from "node:test";
import assert from "node:assert/strict";
import { sameTeamIdentity, teamIdentityEvidence } from "../src/history/teamAliases.js";

test("provider-confirmed domestic aliases keep one football identity", () => {
  assert.equal(sameTeamIdentity("SC Paderborn 07", "Paderborn"), true);
  assert.equal(sameTeamIdentity("AZ", "AZ Alkmaar"), true);
  assert.equal(sameTeamIdentity("CA Mineiro", "Atlético Mineiro"), true);
  assert.equal(sameTeamIdentity("RB Bragantino", "Bragantino"), true);
  assert.equal(teamIdentityEvidence("AZ").teamId, "133767");
  assert.equal(sameTeamIdentity("NEC", "NEC FC"), false);
  assert.equal(teamIdentityEvidence("NEC").teamId, "133760");
  assert.deepEqual(teamIdentityEvidence("SC Paderborn 07").historicalLeagues,[{id:"4399",season:"2025-2026",name:"German 2. Bundesliga"}]);
  assert.deepEqual(teamIdentityEvidence("ES Troyes AC").historicalLeagues,[{id:"4401",season:"2025-2026",name:"French Ligue 2"}]);
});
