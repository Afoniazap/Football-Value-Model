import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveStateSnapshot, pruneOldSnapshots, snapshotFileName } from "../src/history/stateSnapshots.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fvm-snapshots-"));
}

const sampleState = {
  updatedAt: "2026-09-13T13:40:26.000Z",
  results: [
    {
      id: "fixture-1", home: "Alpha", away: "Beta", category: "NEAR",
      dataQuality: 61, stability: 55, consensusScore: 55, modelCoverage: 1,
      modelsAvailable: 2, redFlags: ["Низкий Consensus"],
      models: [{ name: "Team Strength", quality: 60, explanation: "λ 1.1-0.9" }],
      consensusProbability: { home: 0.4, draw: 0.3, away: 0.3 },
      contextDiagnostic: { status: "OK", source: "LOCAL_HISTORY" },
      markets: [{ label: "П1", probability: 0.4, odds: 2.2, fairOdds: 2.5, marketFair: 0.38, edge: 2, ev: -1, fds: 30 }],
      best: { label: "П1", odds: 2.2, fds: 30 }
    }
  ]
};

// A. snapshot создаётся после успешного refresh
test("A) saveStateSnapshot writes a file into the target directory", () => {
  const dir = tempDir();
  const result = saveStateSnapshot(dir, sampleState, new Date("2026-09-13T13:40:26.000Z"));
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.file));
});

// B. имя файла содержит корректный timestamp
test("B) filename encodes the UTC timestamp, colon-free and Windows/Termux safe", () => {
  const name = snapshotFileName(new Date("2026-09-13T13:40:26.789Z"));
  assert.equal(name, "state-2026-09-13T13-40-26Z.json");
  assert.ok(!name.includes(":"), "filename must not contain characters illegal on Windows");
});

// C. snapshot можно JSON.parse и в нём присутствуют results
test("C) the written snapshot is valid JSON and preserves results/diagnostic fields", () => {
  const dir = tempDir();
  const result = saveStateSnapshot(dir, sampleState, new Date("2026-09-13T13:40:26.000Z"));
  const parsed = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.equal(parsed.updatedAt, sampleState.updatedAt);
  assert.equal(parsed.results.length, 1);
  const r = parsed.results[0];
  assert.equal(r.dataQuality, 61);
  assert.equal(r.stability, 55);
  assert.equal(r.consensusScore, 55);
  assert.deepEqual(r.consensusProbability, { home: 0.4, draw: 0.3, away: 0.3 });
  assert.deepEqual(r.redFlags, ["Низкий Consensus"]);
  assert.equal(r.markets[0].fairOdds, 2.5);
  assert.equal(r.markets[0].marketFair, 0.38);
  assert.equal(r.best.fds, 30);
});

// D. snapshot младше 48 часов сохраняется
// Filesystem mtime is set by the real OS clock, not the fabricated `now`
// passed for naming — so age is controlled directly via fs.utimesSync
// rather than relying on wall-clock timing during the test run.
test("D) a snapshot younger than 48h survives pruning", () => {
  const dir = tempDir();
  const created = new Date("2026-09-13T00:00:00.000Z");
  const result = saveStateSnapshot(dir, sampleState, created);
  fs.utimesSync(result.file, created, created);
  const later = new Date(created.getTime() + 47 * 3600_000); // 47h later
  pruneOldSnapshots(dir, later);
  assert.ok(fs.existsSync(result.file));
});

// E. snapshot старше 48 часов удаляется
test("E) a snapshot older than 48h is removed on the next prune", () => {
  const dir = tempDir();
  const created = new Date("2026-09-13T00:00:00.000Z");
  const result = saveStateSnapshot(dir, sampleState, created);
  fs.utimesSync(result.file, created, created);
  const muchLater = new Date(created.getTime() + 49 * 3600_000); // 49h later
  const removed = pruneOldSnapshots(dir, muchLater);
  assert.ok(!fs.existsSync(result.file));
  assert.ok(removed.includes(path.basename(result.file)));
});

// F. посторонние файлы в директории не удаляются
test("F) files that don't match the snapshot naming pattern are never touched", () => {
  const dir = tempDir();
  const created = new Date("2020-01-01T00:00:00.000Z"); // deliberately ancient
  saveStateSnapshot(dir, sampleState, created);
  const foreignFile = path.join(dir, "README.txt");
  fs.writeFileSync(foreignFile, "do not delete me");
  const alsoForeign = path.join(dir, "state-backup.json"); // looks similar but doesn't match the pattern
  fs.writeFileSync(alsoForeign, "{}");

  pruneOldSnapshots(dir, new Date()); // real "now" — the 2020 snapshot is ancient
  assert.ok(fs.existsSync(foreignFile), "unrelated files must survive pruning");
  assert.ok(fs.existsSync(alsoForeign), "similarly-named but non-matching files must survive pruning");
});

// G. ошибка snapshot-механизма не ломает основной refresh
test("G) a snapshot failure (unwritable directory) is reported, not thrown", () => {
  const dir = tempDir();
  // A file where a directory is expected — mkdirSync/writeFileSync must fail.
  const blocked = path.join(dir, "blocked");
  fs.writeFileSync(blocked, "not a directory");
  let threw = false;
  let result;
  try {
    result = saveStateSnapshot(path.join(blocked, "nested"), sampleState, new Date());
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "saveStateSnapshot must never throw — refresh/bot must keep running");
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

// Category logic is entirely untouched by this module — a snapshot never
// re-derives or mutates VALUE/NEAR/WAIT/NO_BET.
test("saveStateSnapshot never mutates the state object it is given", () => {
  const dir = tempDir();
  const before = JSON.stringify(sampleState);
  saveStateSnapshot(dir, sampleState, new Date());
  assert.equal(JSON.stringify(sampleState), before);
});
