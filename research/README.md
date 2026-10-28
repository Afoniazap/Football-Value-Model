# FVM research (read-only analyses; no production code)

Everything here was produced from an exported *copy* of the Termux data and the committed Termux code `termux-v0.5 @ e7e133c`.
Nothing in this folder changes production, VALUE thresholds, Shadow models, Telegram or data. The branch is **not** meant to be merged.

* `reports/` — Russian reports in the order they were written (stabilization plan -> 27 Oct audit -> grading fix and market shadow -> next-stage analysis -> model root causes -> ratings model design and shrinkage isolation).
  Reports refer to folders as `research_models/`, `research_next/`, `audit_27oct/` and `tools/`; they are `models/`, `next/`, `audit/` and `tools/` here.
* `models/` — chronological replay of the committed model code, shrinkage/home-advantage experiments, rating-model prototypes, `verify_shrinkage_isolation.mjs` (read-only check to run on the Termux tree).
* `next/`, `audit/` — earlier walk-forward and audit scripts.
* `tools/fvm-readonly-audit/` — read-only audit of stored history files.
* `results_*.json` — aggregated numbers only (no per-match or per-bet records, no raw data, no keys).

Not included on purpose: exported data, SQLite files, caches, archives, `.env`, per-bet outputs.
The grading fix lives on the separate branch `claude/termux-grading-fix`.
Scripts take paths as arguments; most need Node >= 22 (node:sqlite) or Python 3.11 (`python3 -I`, standard library only).
