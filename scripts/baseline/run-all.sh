#!/usr/bin/env bash
# One safe command: baseline capture + censuses + name corpus + legacy identity snapshot (+ optional replay). Read-only.
#   bash scripts/baseline/run-all.sh [days-for-replay=14] [commit ...]
# Output: data/baseline/<UTC stamp>/ (data/ is gitignored). Never reads .env, never calls a provider API, never writes the SQLite.
set -u
cd "$(dirname "$0")/../.."
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="data/baseline/$STAMP"
DB="${FVM_DB:-data/history/football.sqlite}"
mkdir -p "$OUT"
echo "== output: $OUT"
echo "== git: $(git rev-parse --short HEAD) $(git rev-parse --abbrev-ref HEAD) dirty=$([ -n "$(git status --porcelain)" ] && echo yes || echo no)"
node --no-warnings scripts/baseline/capture.mjs --out "$OUT" --db "$DB" > "$OUT/capture.summary.json" && echo "capture: ok"
node --no-warnings scripts/baseline/freeze-db.mjs "$DB" "$OUT/football.frozen.sqlite" > "$OUT/freeze.summary.json" && echo "freeze-db: ok (frozen copy for reproducible replays)"
node --no-warnings scripts/baseline/identity-census.mjs "$DB" > "$OUT/identity-census.json" && echo "identity-census: ok"
node --no-warnings scripts/baseline/name-corpus.mjs "$DB" data/state.json > "$OUT/name-corpus.json" && echo "name-corpus: ok"
node --no-warnings scripts/baseline/identity-legacy-snapshot.mjs "$OUT/name-corpus.json" > "$OUT/identity-legacy-snapshot.json" && echo "identity-legacy-snapshot: ok"
if [ -f data/state.json ]; then
  node --no-warnings scripts/baseline/fixture-dup-census.mjs data/state.json > "$OUT/fixture-dup-census.json" && echo "fixture-dup-census (state): ok"
fi
if [ -d data/history/state-snapshots ]; then
  : > "$OUT/fixture-dup-census.snapshots.txt"
  for f in data/history/state-snapshots/state-*.json; do
    [ -f "$f" ] && echo "$f: $(node --no-warnings scripts/baseline/fixture-dup-census.mjs "$f" | grep -c '"kind"')" >> "$OUT/fixture-dup-census.snapshots.txt"
  done
  echo "fixture-dup-census (snapshots): ok"
fi
DAYS="${1:-14}"; shift 2>/dev/null
if [ "$#" -gt 0 ] && [ -f data/statistics/predictions.jsonl ]; then
  node --no-warnings scripts/baseline/replay-drift.mjs "$DAYS" "$OUT/football.frozen.sqlite" "$@" > "$OUT/replay-drift.json" && echo "replay-drift: ok"
else
  echo "replay-drift: skipped (pass commits: bash scripts/baseline/run-all.sh 14 7f383c1 9977de8 0b72b25 89b4edb e7e133c)"
fi
echo "== done. Send back: $OUT/capture.summary.json, identity-census.json (head), fixture-dup-census*.json/txt, replay-drift.json (head)"
