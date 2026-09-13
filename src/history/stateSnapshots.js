import fs from "node:fs";
import path from "node:path";

// Diagnostic-only: lets a later investigation reconstruct exactly what a
// past refresh computed (Model %, Fair/Edge/EV, DQ/Stability/Confidence,
// redFlags...) even after a newer refresh has overwritten data/state.json.
// Never allowed to affect the refresh itself — every failure here is caught
// and logged, never thrown.
const RETENTION_MS = 48 * 3600_000;
const FILE_PATTERN = /^state-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/;

// Windows/Termux-safe: ISO timestamp with colons (illegal in Windows
// filenames) replaced by "-", milliseconds dropped for readability.
function snapshotTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function snapshotFileName(date = new Date()) {
  return `state-${snapshotTimestamp(date)}.json`;
}

// Deletes only files matching our own naming pattern and older than
// maxAgeMs (by filesystem mtime) — anything else in the directory is left
// untouched. Never throws: a listing or delete failure just means fewer
// files got cleaned this run, not a broken refresh.
export function pruneOldSnapshots(dir, now = new Date(), maxAgeMs = RETENTION_MS) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!FILE_PATTERN.test(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now.getTime() - stat.mtimeMs > maxAgeMs) {
      try {
        fs.unlinkSync(full);
        removed.push(entry);
      } catch (error) {
        console.error(`state snapshot prune failed for ${entry}: ${error.message}`);
      }
    }
  }
  return removed;
}

// Writes a full copy of the already-assembled `state` object (same shape as
// data/state.json — results, best, markets, models, consensusProbability,
// contextDiagnostic, dataQuality, stability, redFlags, FDS/confidence parts,
// etc. — nothing re-derived, nothing new). Then prunes snapshots older than
// 48h. Always returns a result object instead of throwing, so a caller never
// needs its own try/catch to stay safe.
export function saveStateSnapshot(dir, state, now = new Date()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, snapshotFileName(now));
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    pruneOldSnapshots(dir, now);
    return { ok: true, file };
  } catch (error) {
    console.error(`state snapshot failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}
