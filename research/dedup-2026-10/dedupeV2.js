// FVM — research-only replacement for sqliteHistory.js's dedupeLogicalMatches.
//
// Status: EXPERIMENTAL. Not wired into src/, not imported by app.js, not used
// by any production code path. Produced for the 2026-10-20 deduplication
// research task. Do not import this file from src/ without owner approval.
//
// Scope of the problem (confirmed by reading the real production code in
// origin/termux-v0.5 @ e7e133cb, read-only, nothing there was modified):
//   - sqliteHistory.js's insertRow() stores identityKey using
//     canonicalTeamName(raw) WITHOUT alias resolution, so two providers that
//     spell the same club differently ("PSV" / "PSV Eindhoven") each get
//     their own permanent row. This is intentional (provenance/audit trail
//     is preserved for every provider row) — the dedup therefore has to
//     happen at READ time, not by deleting rows.
//   - The existing read-time collapse, dedupeLogicalMatches(rows), groups by
//     an ordered (home,away) identity pair and a single 24h time window. It
//     does NOT check competition/season, and does NOT check whether the two
//     candidate rows even agree on the final score before collapsing them.
//   - resultMatching.js (a different, independent matching path used for
//     prediction settlement) already uses a two-tier design for exactly this
//     reason: a tight 12h name-only window, and a much wider 30-day window
//     that is only trusted when backed by a stronger signal (an exact
//     provider fixture ID). dedupeLogicalMatches has no equivalent wide tier
//     at all, so a genuine same-match pair whose two providers disagree on
//     kickoff time by more than 24h (confirmed real cases in
//     resultMatching.js's own comments: +3, +7, +15 days after a
//     postponement) is never collapsed and stays a visible duplicate.
//
// This module proposes a conservative widening: a second, wider window that
// is only trusted when competition+season AND the final score agree, and an
// explicit AMBIGUOUS verdict (never auto-merged) for every case that looks
// like the same fixture but has a signal in conflict (different score,
// different declared competition at short range). It never merges a
// reversed (home/away swapped) fixture, and it adds an explicit squad-tier
// guard (youth/women/reserve) on top of whatever the injected team-identity
// resolver already does, as defense in depth.
//
// Dependency injection: this module has no opinion on how two team names are
// compared. The caller supplies `teamIdentity` ({ sameTeamIdentity(a,b),
// canonicalTeamIdentity(name) }). In production use this MUST be the real,
// unmodified src/history/teamAliases.js exports from the user's own
// termux-v0.5 checkout (see run-local-audit.mjs) — this file ships no copy
// of that curated alias data.

export const DEFAULT_TIGHT_WINDOW_MS = 24 * 3600_000; // same as production DUPLICATE_WINDOW_MS
export const DEFAULT_WIDE_WINDOW_MS = 30 * 24 * 3600_000; // same ceiling resultMatching.js already trusts for exact-ID evidence

const TIER_MARKERS = [
  { label: "YOUTH", re: /\b(u1[5-9]|u2[0-3]|youth|junior|juvenil|juniors)\b/i },
  { label: "WOMEN", re: /\b(women|ladies|femenino|feminine|femmes|frauen|dames|feminin)\b/i },
  { label: "RESERVE", re: /\b(ii|reserves?|castilla|b[- ]?team|vitesse|sub[- ]?23|atletic|promeses)\b/i }
];

function tierOf(name) {
  const value = String(name || "");
  for (const { label, re } of TIER_MARKERS) if (re.test(value)) return label;
  return null;
}

function identityOf(teamIdentity, name) {
  return teamIdentity?.canonicalTeamIdentity ? teamIdentity.canonicalTeamIdentity(name) : String(name || "").trim().toLowerCase();
}

function sameIdentity(teamIdentity, a, b) {
  if (teamIdentity?.sameTeamIdentity) return teamIdentity.sameTeamIdentity(a, b);
  return identityOf(teamIdentity, a) === identityOf(teamIdentity, b);
}

function timeOf(row) {
  const ms = new Date(row.playedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function finiteScore(row, side) {
  const value = row.score?.fullTime?.[side];
  return Number.isFinite(value) ? value : null;
}

function competitionSignal(a, b) {
  const codeA = a.competition?.code ? String(a.competition.code).toUpperCase() : null;
  const codeB = b.competition?.code ? String(b.competition.code).toUpperCase() : null;
  if (codeA && codeB) return codeA === codeB ? "SAME" : "DIFFERENT";
  const nameA = a.competition?.name ? String(a.competition.name).trim().toLowerCase() : null;
  const nameB = b.competition?.name ? String(b.competition.name).trim().toLowerCase() : null;
  if (nameA && nameB) return nameA === nameB ? "SAME" : "DIFFERENT";
  return "UNKNOWN";
}

function seasonSignal(a, b) {
  const seasonA = a.competition?.season != null ? String(a.competition.season).slice(0, 4) : null;
  const seasonB = b.competition?.season != null ? String(b.competition.season).slice(0, 4) : null;
  if (seasonA && seasonB) return seasonA === seasonB ? "SAME" : "DIFFERENT";
  return "UNKNOWN";
}

function scoreSignal(a, b) {
  const ah = finiteScore(a, "home"), aa = finiteScore(a, "away");
  const bh = finiteScore(b, "home"), ba = finiteScore(b, "away");
  if (ah === null || aa === null || bh === null || ba === null) return "UNKNOWN";
  return ah === bh && aa === ba ? "MATCH" : "CONFLICT";
}

/**
 * Pairwise classification of two history rows that were already bucketed
 * under the same ordered (home,away) identity pair. Never looks at more than
 * the two rows passed in — no corpus-wide state, no mutation.
 *
 * Returns { verdict: "DUPLICATE"|"AMBIGUOUS"|"DIFFERENT", reasons: string[], evidence }
 */
export function classifyPair(a, b, options = {}) {
  const {
    teamIdentity = null,
    tightWindowMs = DEFAULT_TIGHT_WINDOW_MS,
    wideWindowMs = DEFAULT_WIDE_WINDOW_MS
  } = options;

  const reasons = [];

  const tierA = [tierOf(a.homeTeam?.name), tierOf(a.awayTeam?.name)];
  const tierB = [tierOf(b.homeTeam?.name), tierOf(b.awayTeam?.name)];
  if (tierA[0] !== tierB[0] || tierA[1] !== tierB[1]) {
    reasons.push(`squad-tier mismatch (${JSON.stringify(tierA)} vs ${JSON.stringify(tierB)})`);
    return { verdict: "DIFFERENT", reasons, evidence: { tierA, tierB } };
  }

  const homeMatches = sameIdentity(teamIdentity, a.homeTeam?.name, b.homeTeam?.name);
  const awayMatches = sameIdentity(teamIdentity, a.awayTeam?.name, b.awayTeam?.name);
  const reversed = sameIdentity(teamIdentity, a.homeTeam?.name, b.awayTeam?.name) &&
    sameIdentity(teamIdentity, a.awayTeam?.name, b.homeTeam?.name);

  if (!(homeMatches && awayMatches)) {
    if (reversed) reasons.push("home/away reversed — never the same fixture");
    else reasons.push("team pair does not match on either side");
    return { verdict: "DIFFERENT", reasons, evidence: { homeMatches, awayMatches, reversed } };
  }

  const ta = timeOf(a), tb = timeOf(b);
  if (ta === null || tb === null) {
    reasons.push("unparseable playedAt on at least one row");
    return { verdict: "AMBIGUOUS", reasons, evidence: { ta, tb } };
  }
  const deltaMs = Math.abs(ta - tb);
  const competition = competitionSignal(a, b);
  const season = seasonSignal(a, b);
  const score = scoreSignal(a, b);
  const evidence = { deltaMs, competition, season, score };

  if (deltaMs <= tightWindowMs) {
    if (score === "CONFLICT") {
      reasons.push("same pair within 24h, but reported scores disagree");
      return { verdict: "AMBIGUOUS", reasons, evidence };
    }
    if (competition === "DIFFERENT") {
      reasons.push("same pair within 24h, but declared competition differs");
      return { verdict: "AMBIGUOUS", reasons, evidence };
    }
    reasons.push("same pair within 24h, competition/score consistent");
    return { verdict: "DUPLICATE", reasons, evidence };
  }

  if (deltaMs <= wideWindowMs) {
    if (competition === "SAME" && season !== "DIFFERENT" && score === "MATCH") {
      reasons.push("wide window justified: same competition+season, identical final score (likely postponement/reschedule drift)");
      return { verdict: "DUPLICATE", reasons, evidence };
    }
    if (competition === "SAME" && season !== "DIFFERENT" && score === "CONFLICT") {
      reasons.push("same pair/competition/season within wide window, but scores disagree — needs manual review");
      return { verdict: "AMBIGUOUS", reasons, evidence };
    }
    reasons.push("gap beyond 24h without strong enough corroboration to merge automatically");
    return { verdict: "DIFFERENT", reasons, evidence };
  }

  reasons.push("gap exceeds wide window — treated as a separate (e.g. reverse-fixture-in-another-month) match");
  return { verdict: "DIFFERENT", reasons, evidence };
}

function pairKey(teamIdentity, row) {
  return `${identityOf(teamIdentity, row.homeTeam?.name)}|${identityOf(teamIdentity, row.awayTeam?.name)}`;
}

/**
 * Groups rows into logical-match clusters. A row only joins an existing
 * cluster if EVERY member of that cluster classifies as DUPLICATE against it
 * (clique requirement — deliberately conservative: no transitive chaining,
 * so a long drifting chain of ambiguous pairs can never silently collapse
 * two genuinely different matches just because each neighbour looked close
 * enough to the next one).
 *
 * Returns { clusters, ambiguousPairs } where:
 *   clusters        -> [{ rows: [...], size }] with size > 1 are the proposed merges
 *   ambiguousPairs   -> [{ a, b, reasons, evidence }] needing manual review
 */
export function groupLogicalMatches(rows, options = {}) {
  const buckets = new Map();
  for (const row of rows) {
    const key = pairKey(options.teamIdentity, row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const clusters = [];
  const ambiguousPairs = [];

  for (const bucketRows of buckets.values()) {
    const ordered = [...bucketRows].sort((x, y) => (timeOf(x) ?? 0) - (timeOf(y) ?? 0));
    const openClusters = []; // { rows: [...] }
    for (const row of ordered) {
      let placed = false;
      for (const cluster of openClusters) {
        const verdicts = cluster.rows.map(member => classifyPair(member, row, options));
        if (verdicts.every(v => v.verdict === "DUPLICATE")) {
          cluster.rows.push(row);
          placed = true;
          break;
        }
        const ambiguous = verdicts.find(v => v.verdict === "AMBIGUOUS");
        if (ambiguous) {
          ambiguousPairs.push({ a: cluster.rows[verdicts.indexOf(ambiguous)], b: row, reasons: ambiguous.reasons, evidence: ambiguous.evidence });
        }
      }
      if (!placed) openClusters.push({ rows: [row] });
    }
    clusters.push(...openClusters);
  }

  return { clusters, ambiguousPairs };
}

/**
 * Deterministic pick of which row in a confirmed-duplicate cluster should be
 * the one surfaced to callers (mirrors dedupeLogicalMatches's existing
 * "most recent playedAt, tie-broken by recordKey" rule so behaviour is
 * unchanged for every cluster the OLD algorithm already collapsed — the new
 * algorithm only adds coverage, it does not change which row wins an
 * existing merge).
 */
export function pickCanonical(clusterRows) {
  return [...clusterRows].sort((a, b) =>
    String(b.playedAt).localeCompare(String(a.playedAt)) || String(a.recordKey).localeCompare(String(b.recordKey))
  )[0];
}

/**
 * Drop-in replacement for dedupeLogicalMatches(rows): one row per confirmed
 * logical match, ambiguous clusters are NEVER collapsed (every row is kept,
 * same as "different" — requirement #7: never silently delete an
 * ambiguous case).
 */
export function dedupeLogicalMatchesV2(rows, options = {}) {
  const { clusters } = groupLogicalMatches(rows, options);
  return clusters.map(cluster => pickCanonical(cluster.rows));
}

/**
 * Diagnostic report: every cluster the new algorithm would collapse
 * (size > 1), plus every pair flagged ambiguous. Read-only, same shape
 * family as sqliteHistory.js's findLogicalDuplicates but with full
 * evidence per group instead of just names.
 */
export function auditCorpus(rows, options = {}) {
  const { clusters, ambiguousPairs } = groupLogicalMatches(rows, options);
  const duplicateGroups = clusters
    .filter(cluster => cluster.rows.length > 1)
    .map(cluster => ({
      size: cluster.rows.length,
      canonical: pickCanonical(cluster.rows),
      rows: cluster.rows.map(row => ({
        recordKey: row.recordKey, playedAt: row.playedAt, home: row.homeTeam?.name, away: row.awayTeam?.name,
        competition: row.competition, score: row.score?.fullTime, source: row.provenance?.source || row.provenance?.sources
      }))
    }));
  return {
    totalRows: rows.length,
    duplicateGroups,
    duplicateRowsRemoved: duplicateGroups.reduce((sum, g) => sum + (g.size - 1), 0),
    ambiguousGroups: ambiguousPairs.map(({ a, b, reasons, evidence }) => ({
      a: { recordKey: a.recordKey, playedAt: a.playedAt, home: a.homeTeam?.name, away: a.awayTeam?.name, competition: a.competition, score: a.score?.fullTime },
      b: { recordKey: b.recordKey, playedAt: b.playedAt, home: b.homeTeam?.name, away: b.awayTeam?.name, competition: b.competition, score: b.score?.fullTime },
      reasons, evidence
    }))
  };
}
