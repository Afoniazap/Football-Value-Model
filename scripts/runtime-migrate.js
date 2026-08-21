import { loadConfig } from "../src/config/env.js";
import { copyRuntimeData, ensureRuntimeDir } from "../src/storage/runtime.js";

const config = loadConfig();
ensureRuntimeDir(config.runtimeRoot);
const result = copyRuntimeData({ fromRoot: config.root, toRuntimeRoot: config.runtimeRoot });

console.log(JSON.stringify({
  source: result.source,
  target: result.target,
  copied: result.copied,
  skippedExisting: result.skipped,
  reason: result.reason || null
}, null, 2));