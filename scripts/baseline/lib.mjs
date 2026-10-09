// Shared helpers for the read-only baseline kit (scripts/baseline/*). Nothing here is imported by src/.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const args = (argv = process.argv.slice(2)) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; } else out._.push(argv[i]);
  }
  return out;
};

export const round = (value, digits = 6) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
export const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

export function gitInfo(cwd = process.cwd()) {
  const git = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" }).stdout?.trim() || null;
  return { commit: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: Boolean(git("status", "--porcelain")) };
}

// Keys are sorted so that the digest does not depend on property insertion order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

const probability = p => (p ? { home: round(p.home), draw: round(p.draw), away: round(p.away) } : null);

/**
 * The control tuple of one analysed fixture: everything the owner asked to keep as the reference
 * (coverage, DQ, Agreement, Stability, probabilities, category) plus the λ/lines that explain them.
 * Only selected fields are copied (never the whole state): no keys, no provider error text.
 */
export function controlTuple(x) {
  const b = x.best || {};
  const local = x.contextDiagnostic?.localHistory || {};
  const baseline = x.contextDiagnostic?.baseline || {};
  return {
    id: String(x.id ?? ""),
    fixture: `${x.home} - ${x.away}`,
    competitionCode: x.competitionCode ?? null,
    utcDate: x.utcDate ?? null,
    category: x.category ?? null,
    modelsAvailable: x.modelsAvailable ?? null,
    modelCoverage: x.modelCoverage ?? null,
    dq: x.dataQuality ?? null,
    dqParts: x.dataQualityV2 ? Object.fromEntries(["sampleScore", "freshnessScore", "homeAwayScore", "formScore", "marketScore", "xgScore", "squadScore"].map(k => [k, x.dataQualityV2[k] ?? null])) : null,
    agreement: x.modelAgreement ?? x.consensusScore ?? null,
    stability: x.stability ?? null,
    sciPenalty: x.stabilityV2?.sciPenalty ?? null,
    marketAgreement: x.marketAgreement ?? null,
    consensus: probability(x.consensusProbability),
    models: (x.models || []).map(m => ({
      name: m.name, quality: m.quality ?? null, p: probability(m.probability),
      lambdas: m.lambdas ? { home: round(m.lambdas.home), away: round(m.lambdas.away) } : null
    })),
    best: x.best ? {
      market: b.market ?? null, label: b.label ?? null, odds: b.odds ?? b.bestOdds ?? null, bookmaker: b.bookmaker ?? b.bestBookmaker ?? null,
      probability: round(b.probability), edge: round(b.edge, 4), ev: round(b.ev, 4), confidence: b.confidence ?? null, fds: b.fds ?? null
    } : null,
    redFlags: Array.isArray(x.redFlags) ? x.redFlags.length : null,
    history: { homeMatches: local.homeMatches ?? null, awayMatches: local.awayMatches ?? null, homeVenueMatches: local.homeVenueMatches ?? null, awayVenueMatches: local.awayVenueMatches ?? null, venueSplitMature: local.venueSplitMature ?? null },
    baseline: { source: baseline.baselineSource ?? null, sample: baseline.baselineSample ?? null, teams: baseline.baselineTeams ?? null },
    market: { source: x.marketDiagnostic?.selectedSource ?? x.marketSource ?? null, freshness: x.marketDiagnostic?.freshness ?? x.marketFreshness ?? null, bookmakers: x.marketDiagnostic?.normalizedBookmakers ?? null }
  };
}

export function summarize(tuples) {
  const count = pick => tuples.filter(pick).length;
  const mean = key => { const v = tuples.map(t => t[key]).filter(Number.isFinite); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 3) : null; };
  return {
    fixtures: tuples.length,
    byCategory: Object.fromEntries(["VALUE", "NEAR", "WAIT", "NO_BET"].map(c => [c, count(t => t.category === c)])),
    modelsAvailable: { 0: count(t => !t.modelsAvailable), 1: count(t => t.modelsAvailable === 1), 2: count(t => t.modelsAvailable === 2) },
    withConsensusProbability: count(t => t.consensus && Number.isFinite(t.consensus.home)),
    meanDq: mean("dq"), meanAgreement: mean("agreement"), meanStability: mean("stability")
  };
}
