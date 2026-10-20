#!/usr/bin/env node
// FVM — safe, read-only, autonomous research audit for the 2026-10-20
// deduplication task. Run this in Termux, pointed at your REAL checkout and
// a REAL SQLite file. It never modifies either.
//
//   node research/dedup-2026-10/run-local-audit.mjs \
//     --repo ~/FVM-Android-Termux-v0.5 \
//     --db ~/fvm-fb-backup-v8NrXs/football.sqlite \
//     --audit-dir ~/fallback-audit-20261020-072741 \
//     --out ~/fvm-dedup-research-output \
//     [--fixtures ~/probe-fixtures.json] \
//     [--focus-teams "Vitória SC,Vasco da Gama,Cardiff City"]
//
// SAFETY (enforced in code, not just documented):
//   - --db is NEVER opened at its given path. It is copied (fs.copyFileSync)
//     into a throwaway temp directory first; every SQLite handle this script
//     opens points at a copy, never the original file.
//   - --repo is NEVER written to. Its modules are loaded with a read-only
//     dynamic import() (ESM import cannot mutate the source files on disk).
//   - This script performs zero merge/push/deploy/restart/.env access. It
//     writes only inside --out and inside its own temp directory.
//   - The "after" comparison copy has rows deleted ONLY for groups this
//     script itself classified as DUPLICATE (never AMBIGUOUS, never
//     DIFFERENT), and only inside that disposable copy.
//
// Requires Node >=22.5 (node:sqlite), matching the repo's own package.json.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { auditCorpus, dedupeLogicalMatchesV2 } from "./dedupeV2.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = value;
  }
  return out;
}

function requireArg(args, name) {
  if (!args[name]) {
    console.error(`Missing required --${name}. See the header of this file for usage.`);
    process.exit(1);
  }
  return args[name];
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyDbSafely(originalPath, label) {
  const dir = tempDir(`fvm-dedup-${label}-`);
  const dest = path.join(dir, "football.sqlite");
  fs.copyFileSync(originalPath, dest); // read original once, never opened directly
  return dest;
}

async function importFromRepo(repo, relPath) {
  const full = path.join(repo, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Expected production file not found at ${full} — is --repo pointing at the right checkout (termux-v0.5)?`);
  }
  return import(pathToFileURL(full).href);
}

function bestEffortLoadAuditDir(auditDir) {
  if (!auditDir || !fs.existsSync(auditDir)) return { loaded: false, records: [], note: "audit-dir not provided or not found" };
  const files = fs.readdirSync(auditDir).filter(f => /\.(json|csv)$/i.test(f));
  const records = [];
  for (const file of files) {
    const full = path.join(auditDir, file);
    try {
      if (file.endsWith(".json")) {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        const rows = Array.isArray(data) ? data : Array.isArray(data.records) ? data.records : Array.isArray(data.duplicates) ? data.duplicates : null;
        if (rows) records.push(...rows.map(r => ({ ...r, __file: file })));
      } else {
        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/).filter(Boolean);
        if (lines.length > 1) {
          const headers = lines[0].split(",").map(h => h.trim());
          for (const line of lines.slice(1)) {
            const cells = line.split(",");
            const record = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
            records.push({ ...record, __file: file });
          }
        }
      }
    } catch (error) {
      console.warn(`Could not parse ${file} from --audit-dir (${error.message}) — skipping, independent rediscovery is unaffected.`);
    }
  }
  return { loaded: records.length > 0, records, filesScanned: files };
}

function matchesFocusTeam(group, focusTeams) {
  const names = [group.canonical?.home, group.canonical?.away, ...(group.rows || []).flatMap(r => [r.home, r.away])];
  return focusTeams.some(team => names.some(name => String(name || "").toLowerCase().includes(team.toLowerCase())));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(requireArg(args, "repo"));
  const originalDb = path.resolve(requireArg(args, "db"));
  const outDir = path.resolve(requireArg(args, "out"));
  const auditDir = args["audit-dir"] ? path.resolve(args["audit-dir"]) : null;
  const focusTeams = (args["focus-teams"] || "Vitória SC,Vitória,Vasco da Gama,Cardiff City").split(",").map(s => s.trim()).filter(Boolean);
  const fixturesPath = args.fixtures ? path.resolve(args.fixtures) : null;

  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(originalDb)) throw new Error(`--db not found: ${originalDb}`);
  if (!fs.existsSync(repo)) throw new Error(`--repo not found: ${repo}`);

  console.log("Loading production modules read-only from", repo);
  const sqliteHistory = await importFromRepo(repo, "src/history/sqliteHistory.js");
  const teamAliases = await importFromRepo(repo, "src/history/teamAliases.js");
  let auditFixtureForecastMod = null;
  try { auditFixtureForecastMod = await importFromRepo(repo, "scripts/audit-fixture-forecast.js"); }
  catch (error) { console.warn("scripts/audit-fixture-forecast.js not importable (" + error.message + ") — BASE probability deltas will be skipped, sample-size deltas still run."); }

  const teamIdentity = { sameTeamIdentity: teamAliases.sameTeamIdentity, canonicalTeamIdentity: teamAliases.canonicalTeamIdentity };

  console.log("Copying --db (original is never opened directly)...");
  const beforeDbPath = copyDbSafely(originalDb, "before");
  const beforeDb = sqliteHistory.openHistoryDatabase(beforeDbPath);

  const stats = sqliteHistory.databaseStats(beforeDb, beforeDbPath);
  console.log(`Loaded copy: ${stats.matches} rows (matches production table).`);

  const allRows = sqliteHistory.loadAllHistory(beforeDb); // raw, bypasses any dedup — same view FALLBACK v2 likely audited
  console.log(`loadAllHistory (no dedup applied): ${allRows.length} rows.`);

  const oldDiagnostic = sqliteHistory.findLogicalDuplicates(allRows); // production's own existing diagnostic (24h/name-only)
  console.log(`Production findLogicalDuplicates (24h, name-only): ${oldDiagnostic.length} groups.`);

  const newReport = auditCorpus(allRows, { teamIdentity });
  console.log(`New algorithm: ${newReport.duplicateGroups.length} confirmed-duplicate groups (${newReport.duplicateRowsRemoved} rows would be collapsed), ${newReport.ambiguousGroups.length} ambiguous pairs flagged for manual review.`);

  const auditCross = bestEffortLoadAuditDir(auditDir);
  console.log(auditCross.loaded
    ? `Cross-referenced ${auditCross.records.length} records from --audit-dir (${auditCross.filesScanned.join(", ")}).`
    : `--audit-dir not machine-readable or not supplied (${auditCross.note || ""}) — proceeding on independent rediscovery only.`);

  // Idempotency: re-run grouping on the already-deduped output.
  const deduped = dedupeLogicalMatchesV2(allRows, { teamIdentity });
  const secondPass = auditCorpus(deduped, { teamIdentity });
  const idempotent = secondPass.duplicateGroups.length === 0;
  console.log(`Idempotency check: ${idempotent ? "PASS" : "FAIL"} (second pass found ${secondPass.duplicateGroups.length} further merges; expected 0).`);

  // Build the "after" comparison copy: delete only rows that LOST a confirmed
  // duplicate cluster (the row NOT picked as canonical). AMBIGUOUS/DIFFERENT
  // rows are untouched.
  console.log("Building disposable 'after' copy for BASE sample-size comparison (original --db untouched)...");
  const afterDbPath = copyDbSafely(originalDb, "after");
  const afterDb = sqliteHistory.openHistoryDatabase(afterDbPath);
  const toRemove = [];
  for (const group of newReport.duplicateGroups) {
    for (const row of group.rows) {
      if (row.recordKey !== group.canonical.recordKey) toRemove.push(row.recordKey);
    }
  }
  const idLookup = afterDb.prepare("SELECT id, providerFixtureId FROM matches");
  const byProviderFixtureId = new Map(idLookup.all().map(r => [r.providerFixtureId, r.id]));
  let removed = 0;
  const del = afterDb.prepare("DELETE FROM matches WHERE id = ?");
  for (const recordKeyLike of toRemove) {
    // recordKey in decoded rows is `${source}:${providerFixtureId}` style for most sources,
    // or `SQLITE:<id>` when re-decoded from this same table — handle both.
    const sqliteIdMatch = /^SQLITE:(\d+)$/.exec(recordKeyLike);
    if (sqliteIdMatch) { del.run(Number(sqliteIdMatch[1])); removed += 1; continue; }
    const providerFixtureId = recordKeyLike.includes(":") ? recordKeyLike.split(":").slice(1).join(":") : recordKeyLike;
    const id = byProviderFixtureId.get(providerFixtureId);
    if (id != null) { del.run(id); removed += 1; }
  }
  console.log(`'after' copy: removed ${removed}/${toRemove.length} losing rows from confirmed-duplicate groups.`);

  // BASE sample-size deltas per affected competition/season (safe: only counts rows,
  // reuses the REAL unmodified buildCompetitionBaseline/getCompetitionSeasonMatches).
  const competitionBaseline = await importFromRepo(repo, "src/history/competitionBaseline.js");
  const affectedCompetitions = [...new Map(newReport.duplicateGroups.map(g => {
    const c = g.canonical.competition || {};
    const key = `${c.code || c.name || "UNKNOWN"}|${String(c.season || "").slice(0, 4)}`;
    return [key, { code: c.code, name: c.name, season: String(c.season || "").slice(0, 4) }];
  })).values()];

  const baselineDeltas = affectedCompetitions.filter(c => c.code && c.season).map(c => {
    const before = competitionBaseline.buildCompetitionBaseline(beforeDb, c.code, c.season, "9999-12-31T23:59:59.999Z");
    const after = competitionBaseline.buildCompetitionBaseline(afterDb, c.code, c.season, "9999-12-31T23:59:59.999Z");
    return {
      competitionCode: c.code, season: c.season,
      sampleCurrentSeasonBefore: before.sampleCurrentSeason, sampleCurrentSeasonAfter: after.sampleCurrentSeason,
      samplePreviousSeasonBefore: before.samplePreviousSeason, samplePreviousSeasonAfter: after.samplePreviousSeason,
      baselineTeamsBefore: before.current?.baselineTeams ?? null, baselineTeamsAfter: after.current?.baselineTeams ?? null
    };
  });

  // Optional: real BASE PROBABILITY deltas via the production forecast audit,
  // reused unmodified (never reimplemented) — only if a fixture list is given
  // or can be synthesized from the confirmed duplicate groups.
  let fixtures = [];
  if (fixturesPath && fs.existsSync(fixturesPath)) {
    fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
    console.log(`Using ${fixtures.length} user-supplied probe fixtures from ${fixturesPath}.`);
  } else {
    fixtures = newReport.duplicateGroups
      .filter(g => g.canonical.competition?.code)
      .map(g => {
        const latest = g.rows.reduce((max, r) => (new Date(r.playedAt) > new Date(max.playedAt) ? r : max), g.rows[0]);
        return {
          home: g.canonical.home, away: g.canonical.away, competitionCode: g.canonical.competition.code,
          season: String(g.canonical.competition.season || "").slice(0, 4),
          utcDate: new Date(new Date(latest.playedAt).getTime() + 86400_000).toISOString(),
          __synthetic: true
        };
      });
    console.log(`No --fixtures given: synthesized ${fixtures.length} SYNTHETIC probe fixtures (1 day after each affected group's latest row, clearly marked synthetic in the report).`);
  }

  const forecastDeltas = [];
  if (auditFixtureForecastMod) {
    for (const fixture of fixtures) {
      try {
        const before = auditFixtureForecastMod.auditFixtureForecast(beforeDb, fixture, { season: fixture.season });
        const after = auditFixtureForecastMod.auditFixtureForecast(afterDb, fixture, { season: fixture.season });
        const pBefore = before.models?.teamStrength?.probability || null;
        const pAfter = after.models?.teamStrength?.probability || null;
        const deltaPp = pBefore && pAfter
          ? { home: (pAfter.home - pBefore.home) * 100, draw: (pAfter.draw - pBefore.draw) * 100, away: (pAfter.away - pBefore.away) * 100 }
          : null;
        const maxAbsDeltaPp = deltaPp ? Math.max(Math.abs(deltaPp.home), Math.abs(deltaPp.draw), Math.abs(deltaPp.away)) : null;
        forecastDeltas.push({ fixture, synthetic: Boolean(fixture.__synthetic), probabilityBefore: pBefore, probabilityAfter: pAfter, deltaPp, maxAbsDeltaPp, baselineTierBefore: before.baseline?.tier, baselineTierAfter: after.baseline?.tier });
      } catch (error) {
        forecastDeltas.push({ fixture, error: error.message });
      }
    }
  }

  const focusedGroups = newReport.duplicateGroups.filter(g => matchesFocusTeam(g, focusTeams));
  const focusedAmbiguous = newReport.ambiguousGroups.filter(g => focusTeams.some(team =>
    [g.a.home, g.a.away, g.b.home, g.b.away].some(name => String(name || "").toLowerCase().includes(team.toLowerCase()))));

  const report = {
    generatedAt: new Date().toISOString(),
    inputs: { repo, originalDbPathReadOnlyCopySource: originalDb, auditDir },
    totals: { rows: allRows.length, productionFindLogicalDuplicateGroups: oldDiagnostic.length, newConfirmedDuplicateGroups: newReport.duplicateGroups.length, newAmbiguousGroups: newReport.ambiguousGroups.length, duplicateRowsRemoved: newReport.duplicateRowsRemoved },
    idempotency: { pass: idempotent, secondPassMerges: secondPass.duplicateGroups.length },
    auditDirCrossReference: { loaded: auditCross.loaded, recordCount: auditCross.records.length, filesScanned: auditCross.filesScanned || [] },
    baselineSampleDeltas: baselineDeltas,
    forecastProbabilityDeltas: forecastDeltas,
    focusTeams: { names: focusTeams, duplicateGroups: focusedGroups, ambiguousGroups: focusedAmbiguous },
    duplicateGroups: newReport.duplicateGroups,
    ambiguousGroups: newReport.ambiguousGroups
  };

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  const sigDeltas = forecastDeltas.filter(d => d.maxAbsDeltaPp != null);
  const md = [
    "# FVM dedup research — local audit run",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Безопасность",
    "- Исходный `--db` не открывался напрямую — скопирован дважды (before/after) во временный каталог.",
    `- Исходный репозиторий (\`--repo\`) использовался только для чтения (dynamic import).`,
    "- Ничего не записано, кроме этого каталога отчёта и временных копий.",
    "",
    "## Итоги",
    `- Всего строк в SQLite (без дедупликации): ${report.totals.rows}`,
    `- Групп по текущей production-логике (findLogicalDuplicates, 24ч/без алиасов имени): ${report.totals.productionFindLogicalDuplicateGroups}`,
    `- Подтверждённых дублей по новому алгоритму: ${report.totals.newConfirmedDuplicateGroups} (строк к схлопыванию: ${report.totals.duplicateRowsRemoved})`,
    `- Неоднозначных пар (НЕ объединены автоматически): ${report.totals.newAmbiguousGroups}`,
    `- Идемпотентность повторного прогона: ${idempotent ? "PASS" : "FAIL"}`,
    "",
    "## BASE: изменение размера выборки (sample size) по затронутым лигам/сезонам",
    ...baselineDeltas.map(d => `- ${d.competitionCode} ${d.season}: current season sample ${d.sampleCurrentSeasonBefore} -> ${d.sampleCurrentSeasonAfter}, teams ${d.baselineTeamsBefore} -> ${d.baselineTeamsAfter}`),
    "",
    "## BASE: изменение вероятности (реальный teamStrengthModel, не переизобретённый)",
    forecastDeltas.length ? `Фикстур проверено: ${forecastDeltas.length}${fixtures[0]?.__synthetic ? " (синтетические пробные фикстуры — не реальный список пользователя)" : ""}` : "Пропущено: scripts/audit-fixture-forecast.js не импортировался.",
    `- |Δ| > 1 п.п.: ${sigDeltas.filter(d => d.maxAbsDeltaPp > 1).length}`,
    `- |Δ| > 5 п.п.: ${sigDeltas.filter(d => d.maxAbsDeltaPp > 5).length}`,
    `- |Δ| > 10 п.п.: ${sigDeltas.filter(d => d.maxAbsDeltaPp > 10).length}`,
    "",
    "## Отслеживаемые команды",
    ...focusTeams.map(team => {
      const groups = focusedGroups.filter(g => matchesFocusTeam(g, [team]));
      const ambiguous = focusedAmbiguous.filter(g => [g.a.home, g.a.away, g.b.home, g.b.away].some(n => String(n || "").toLowerCase().includes(team.toLowerCase())));
      return `- ${team}: подтверждённых дублей ${groups.length}, неоднозначных пар ${ambiguous.length}`;
    }),
    "",
    "Полные данные (все группы, все доказательства) — см. report.json в этом каталоге."
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "report.md"), md);

  beforeDb.close();
  afterDb.close();
  console.log(`\nDone. Written: ${path.join(outDir, "report.json")} and ${path.join(outDir, "report.md")}`);
  console.log(`(original --db at ${originalDb} was never opened; temp copies remain at ${path.dirname(beforeDbPath)} and ${path.dirname(afterDbPath)} until you delete them)`);
}

main().catch(error => { console.error(error); process.exit(1); });
