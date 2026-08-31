import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

function runDoctor(overrides={}){
  const env={
    ...process.env,
    TELEGRAM_BOT_TOKEN:"test-telegram-token",
    FOOTBALL_DATA_TOKEN:"test-football-data-token",
    THE_ODDS_API_KEY:"test-odds-token",
    API_FOOTBALL_KEY:"",
    ODDS_API_IO_KEY:"",
    ...overrides
  };
  return spawnSync(process.execPath,["scripts/doctor.js"],{
    cwd:root,
    env,
    encoding:"utf8"
  });
}

test("Doctor fails when THE_ODDS_API_KEY is missing",()=>{
  const result=runDoctor({THE_ODDS_API_KEY:""});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stdout,/THE_ODDS_API_KEY: MISSING/);
  assert.match(result.stdout,/DOCTOR: FAIL/);
});

test("Doctor passes without optional API_FOOTBALL_KEY",()=>{
  const result=runDoctor({API_FOOTBALL_KEY:""});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/API_FOOTBALL_KEY: OPTIONAL\/MISSING/);
  assert.match(result.stdout,/DOCTOR: PASS/);
});

test("Doctor passes when all required keys are configured",()=>{
  const result=runDoctor();
  assert.equal(result.status,0,result.stdout+result.stderr);
  for(const key of ["TELEGRAM_BOT_TOKEN","FOOTBALL_DATA_TOKEN","THE_ODDS_API_KEY"]){
    assert.match(result.stdout,new RegExp(`${key}: CONFIGURED`));
  }
  assert.match(result.stdout,/DOCTOR: PASS/);
});
