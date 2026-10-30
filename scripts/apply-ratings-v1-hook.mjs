// Adds the ratings-v1 observer hook to a copy of src/app.js by ANCHORS (so it also works on a working tree with local changes).
//   node scripts/apply-ratings-v1-hook.mjs <path/to/app.js>            dry run: prints what would change, writes nothing
//   node scripts/apply-ratings-v1-hook.mjs <path/to/app.js> --write    writes app.js and a backup app.js.bak-ratings-v1
// Idempotent. If any anchor is missing it aborts WITHOUT writing and prints the manual snippets.
import fs from "node:fs";
export const MARKER = "ratings-v1 observer";
export const IMPORT_LINE = `import { observeRatingsShadow } from "./shadow/ratings/ratingsObserver.js"; // ${MARKER}\n`;
export const CONST_LINE = `const RATINGS_V1_SHADOW_FILE=path.join(DATA,"statistics","ratings-v1-shadow.jsonl"); // ${MARKER}\n`;
export const CALL_BLOCK = `    // ${MARKER}: Shadow-only, flag RATINGS_V1_SHADOW=1, kill file data/statistics/ratings-v1.DISABLED.
    // (cont.) ${MARKER}: reads state.results/history, writes only its own JSONL, never assigns to state, never throws -> cannot change Production output or stop the refresh.
    try{observeRatingsShadow({file:RATINGS_V1_SHADOW_FILE,results:state.results,history:completedHistory,now:storedAt,enabled:/^(1|true|yes)$/i.test(env.RATINGS_V1_SHADOW||"")});}catch{} // ${MARKER}
`;
const ANCHORS = {
  importAfter: /^import \{ updateV3ShadowHistory \} from "\.\/shadow\/v3History\.js";[^\n]*\n/m,
  constAfter: /^const V3_SHADOW_HISTORY_FILE=[^\n]*\n/m,
  callAfter: /try\{\s*\n\s*state\.v3ShadowStatistics=updateV3ShadowHistory\([^\n]*\n\s*\}catch\(e\)\{\s*\n[^\n]*\n\s*\}\n/
};
export function applyHook(source) {
  if (source.includes(MARKER)) return { changed: false, source, reason: "already applied" };
  let out = source;
  for (const [name, re] of Object.entries(ANCHORS)) if (!re.test(out)) return { changed: false, source, reason: `anchor not found: ${name}` };
  out = out.replace(ANCHORS.importAfter, m => m + IMPORT_LINE).replace(ANCHORS.constAfter, m => m + CONST_LINE).replace(ANCHORS.callAfter, m => m + CALL_BLOCK);
  return { changed: true, source: out };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, flag] = process.argv.slice(2);
  if (!file) { console.error("usage: node scripts/apply-ratings-v1-hook.mjs <app.js> [--write]"); process.exit(2); }
  const result = applyHook(fs.readFileSync(file, "utf8"));
  if (!result.changed) {
    console.log(result.reason === "already applied" ? "nothing to do: already applied" : `ABORT (${result.reason}). Add manually:\n1) after the v3History import:\n${IMPORT_LINE}2) after the V3_SHADOW_HISTORY_FILE constant:\n${CONST_LINE}3) after the try/catch around updateV3ShadowHistory:\n${CALL_BLOCK}`);
    process.exit(result.reason === "already applied" ? 0 : 1);
  }
  if (flag === "--write") { fs.copyFileSync(file, `${file}.bak-ratings-v1`); fs.writeFileSync(file, result.source); console.log(`written ${file} (backup ${file}.bak-ratings-v1)`); }
  else { console.log("dry run - would insert:\n" + IMPORT_LINE + CONST_LINE + CALL_BLOCK); }
}
