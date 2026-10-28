// READ-ONLY verification, meant to be run on the Termux working tree (it writes nothing, calls no API).
//   node verify_shrinkage_isolation.mjs <workingTreeRoot> <baselineRoot> <football.sqlite> [sampleSize]
// baselineRoot = clean checkout of the committed code, e.g.  git archive e7e133c | tar x -C /tmp/fvm_base
// Checks that the Production path is unchanged by the shrinkage option and that k>0 is reachable only from Shadow code.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
const [WT, BASE, DBF, N = "300"] = process.argv.slice(2);
const report = { static: {}, runtime: {}, verdict: "PASS", failures: [] };
const fail = msg => { report.verdict = "FAIL"; report.failures.push(msg); };
// ---------- static checks
function walk(dir, out = []) { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { if (["node_modules", ".git", "data", "logs"].includes(f.name)) continue; const p = path.join(dir, f.name); f.isDirectory() ? walk(p, out) : /\.(m?js)$/.test(f.name) && out.push(p); } return out; }
const files = [...walk(path.join(WT, "src")), ...(fs.existsSync(path.join(WT, "scripts")) ? walk(path.join(WT, "scripts")) : [])];
const hits = { shrinkageGames: [], DEFAULT_SHRINKAGE_GAMES: [], experimentHomeFactors: [], analyseFixtureCalls: [], teamStrengthModelCalls: [] };
for (const f of files) {
  const rel = path.relative(WT, f), lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const key of ["shrinkageGames", "DEFAULT_SHRINKAGE_GAMES", "experimentHomeFactors"]) if (line.includes(key)) hits[key].push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
    if (/\banalyseFixture\s*\(/.test(line) && !/export function/.test(line)) hits.analyseFixtureCalls.push(`${rel}:${i + 1}`);
    if (/\bteamStrengthModel\s*\(/.test(line) && !/export function/.test(line)) hits.teamStrengthModelCalls.push(`${rel}:${i + 1}`);
  });
}
report.static = hits;
const modelsSrc = fs.readFileSync(path.join(WT, "src/engine/models.js"), "utf8");
const def = modelsSrc.match(/DEFAULT_SHRINKAGE_GAMES\s*=\s*([0-9.]+)/);
report.static.defaultShrinkageGames = def ? Number(def[1]) : null;
if (!def || Number(def[1]) !== 0) fail("DEFAULT_SHRINKAGE_GAMES is not the literal 0");
// every call that passes a non-zero shrinkage must live in shadow/research code, never in app.js / analyse.js default path
const prodFiles = ["src/app.js"];
for (const rel of prodFiles) { const src = fs.readFileSync(path.join(WT, rel), "utf8"); const m = src.match(/analyseFixture\s*\(([\s\S]*?)\)\s*;/); if (m) { const args = m[1].split(",").length; report.static[`${rel}:analyseFixture_args`] = args; if (/shrinkage/i.test(m[1])) fail(`${rel}: analyseFixture call passes a shrinkage argument`); if (args > 5) fail(`${rel}: analyseFixture is called with ${args} arguments (expected 5, i.e. no options)`); } else fail(`${rel}: analyseFixture call not found`); }
for (const line of hits.shrinkageGames) if (/^src\/app\.js/.test(line)) fail(`shrinkageGames referenced in app.js: ${line}`);
// ---------- runtime parity: working tree default == clean baseline, option reachable only when asked
const [W, B] = await Promise.all([import(path.join(WT, "src/engine/models.js")), import(path.join(BASE, "src/engine/models.js"))]);
const [WA, BA] = await Promise.all([import(path.join(WT, "src/engine/analyse.js")), import(path.join(BASE, "src/engine/analyse.js"))]);
const { canonicalTeamIdentity } = await import(path.join(BASE, "src/history/teamAliases.js"));
const db = new DatabaseSync(DBF, { readOnly: true });
const raw = db.prepare("SELECT competitionCode code, kickoff, homeTeam, awayTeam, homeGoals hg, awayGoals ag FROM matches WHERE status IN ('FT','AET','PEN','FINISHED') AND competitionCode IS NOT NULL ORDER BY kickoff").all().map(r => ({ ...r, h: canonicalTeamIdentity(r.homeTeam), a: canonicalTeamIdentity(r.awayTeam) }));
const byCode = new Map(); for (const r of raw) (byCode.get(r.code) || byCode.set(r.code, []).get(r.code)).push(r);
const table = (rows, mode) => { const t = new Map(); const g = id => t.get(id) || t.set(id, { team: { id }, playedGames: 0, points: 0, goalsFor: 0, goalsAgainst: 0 }).get(id); for (const m of rows) { if (mode !== "AWAY") { const x = g(m.h); x.playedGames++; x.goalsFor += m.hg; x.goalsAgainst += m.ag; x.points += m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0; } if (mode !== "HOME") { const x = g(m.a); x.playedGames++; x.goalsFor += m.ag; x.goalsAgainst += m.hg; x.points += m.ag > m.hg ? 3 : m.ag === m.hg ? 1 : 0; } } return [...t.values()].map(x => ({ ...x, goalDifference: x.goalsFor - x.goalsAgainst })); };
const asE = x => ({ id: x.kickoff + x.h, utcDate: x.kickoff, homeTeam: { id: x.h, name: x.homeTeam }, awayTeam: { id: x.a, name: x.awayTeam }, score: { fullTime: { home: x.hg, away: x.ag } } });
const samples = []; const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
for (const [code, list] of byCode) for (let i = 30; i < list.length; i++) if (rnd() < Number(N) / Math.max(1, raw.length) * 3) { const prior = list.slice(0, i), cur = prior.slice(-250); samples.push({ fx: { homeId: list[i].h, awayId: list[i].a, home: list[i].homeTeam, away: list[i].awayTeam, utcDate: list[i].kickoff, id: String(i) }, ctx: { standings: { standings: [{ type: "TOTAL", table: table(cur, "TOTAL") }, { type: "HOME", table: table(cur, "HOME") }, { type: "AWAY", table: table(cur, "AWAY") }] }, finished: prior.slice(-300).map(asE) } }); }
const config = { minEdge: 4, minEv: 5, minConfidence: 70, minDataQuality: 70, minStability: 70 };
let compared = 0, tsDiff = 0, anDiff = 0, zeroDiff = 0, optionNoEffect = 0;
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" && !Number.isFinite(v)) ? null : v));
for (const { fx, ctx } of samples.slice(0, Number(N))) {
  const a = strip(W.teamStrengthModel(fx, ctx)), b = strip(B.teamStrengthModel(fx, ctx)); compared++;
  if (!isDeepStrictEqual(a, b)) tsDiff++;
  const wa = strip(WA.analyseFixture(fx, ctx, null, config)), ba = strip(BA.analyseFixture(fx, ctx, null, config));
  if (!isDeepStrictEqual(wa.consensusProbability, ba.consensusProbability) || wa.category !== ba.category || !isDeepStrictEqual(wa.models, ba.models)) anDiff++;
  const wz = strip(WA.analyseFixture(fx, ctx, null, config, null, { shrinkageGames: 0 }));
  if (!isDeepStrictEqual(wz.consensusProbability, wa.consensusProbability)) zeroDiff++;
  const w8 = strip(WA.analyseFixture(fx, ctx, null, config, null, { shrinkageGames: 8 }));
  if (isDeepStrictEqual(w8.consensusProbability, wa.consensusProbability)) optionNoEffect++;
}
report.runtime = { contextsCompared: compared, teamStrengthModel_default_differs_from_baseline: tsDiff, analyseFixture_default_differs_from_baseline: anDiff, k0_differs_from_default: zeroDiff, k8_identical_to_default_option_has_no_effect: optionNoEffect };
if (tsDiff) fail(`teamStrengthModel default output differs from the committed baseline in ${tsDiff}/${compared} contexts`);
if (anDiff) fail(`analyseFixture default output differs from the committed baseline in ${anDiff}/${compared} contexts`);
if (zeroDiff) fail(`shrinkageGames=0 differs from default in ${zeroDiff} contexts`);
if (optionNoEffect === compared) fail("shrinkageGames=8 changes nothing: option is not wired");
console.log(JSON.stringify(report, null, 1));
process.exit(report.verdict === "PASS" ? 0 : 1);
